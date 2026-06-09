/**
 * Real-git end-to-end test for the parallel implement path.
 *
 * Every existing implement test uses a fake GitRunner or fake chain elements. This test
 * exercises the parallel path against a REAL git repository so we can trust the worktree
 * lifecycle (add/fold/remove), real commits, branch history, and cleanup before shipping.
 *
 * What is faked:
 *   - HeadlessAiProvider — on generate(), writes a REAL file into the worktree's cwd and
 *     emits the harness signals required for the chain to commit and settle the task `done`.
 *   - ShellScriptRunner — passes unconditionally (exit 0 stub).
 *   - All in-memory repositories (sprint / execution / task) — standard pattern from the
 *     serial e2e tests.
 *
 * What is REAL:
 *   - git (via the real GitRunner backed by cross-platform-spawn)
 *   - worktree add / fold / remove / prune
 *   - cherry-pick fold (the second-task-same-wave fold path)
 *   - file commits on the sprint branch
 *   - worktree cleanup on every exit path
 */

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';

import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';

import { createRunner } from '@src/application/chain/run/runner.ts';
import { createParallelImplementElement } from '@src/application/flows/implement/parallel-element.ts';
import { planImplementWaves } from '@src/application/flows/implement/flow.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/flow.ts';
import { buildWaveBranches, createFoldQueue } from '@src/application/flows/implement/wave-branch.ts';

import {
  absolutePath,
  FIXED_LATER,
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { noopSkillsAdapter, emptySkillSource } from '@tests/fixtures/skills-fakes.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

// ─── skip on Windows — worktrees are posix-heavy ────────────────────────────
if (process.platform === 'win32') {
  describe.skip('parallel implement — real git worktrees (skipped on Windows)', () => {
    it.skip('placeholder', () => undefined);
  });
} else {
  runTests();
}

function runTests(): void {
  // ─── Shared constants ──────────────────────────────────────────────────────
  const SPRINT_BRANCH = 'ralphctl/test-sprint';
  const FAKE_PROJECT_ID = 'proj-parallel-realgit';

  // ─── In-memory repository fakes ───────────────────────────────────────────
  const inMemorySprintRepo = (initial: Sprint): { repo: SprintRepository; current: () => Sprint } => {
    let current: Sprint = initial;
    return {
      repo: {
        async findById(id: SprintId) {
          if (current.id === id) return Result.ok(current);
          return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
        },
        async save(sprint: Sprint) {
          current = sprint;
          return Result.ok(undefined);
        },
        async list() {
          return Result.ok([current]);
        },
      } as unknown as SprintRepository,
      current: () => current,
    };
  };

  const inMemoryExecutionRepo = (
    initial: SprintExecution
  ): { repo: SprintExecutionRepository; current: () => SprintExecution } => {
    let current = initial;
    return {
      repo: {
        async findById(id: SprintId) {
          if (current.sprintId === id) return Result.ok(current);
          return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
        },
        async save(next: SprintExecution) {
          current = next;
          return Result.ok(undefined);
        },
        async remove() {
          return Result.ok(undefined);
        },
      } as unknown as SprintExecutionRepository,
      current: () => current,
    };
  };

  const inMemoryTaskRepo = (
    initial: readonly Task[]
  ): { repo: TaskRepository; tasks: () => readonly Task[]; saveAlls: ReadonlyArray<readonly Task[]> } => {
    let store: Task[] = [...initial];
    const saveAlls: Array<readonly Task[]> = [];
    return {
      repo: {
        async findBySprintId() {
          return Result.ok(store as readonly Task[]);
        },
        async findById(_sprintId: SprintId, taskId: TaskId) {
          const t = store.find((tt) => tt.id === taskId);
          if (t === undefined) return Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
          return Result.ok(t);
        },
        async update(_sprintId: SprintId, task: Task) {
          const idx = store.findIndex((t) => t.id === task.id);
          if (idx >= 0) store[idx] = task;
          else store = [...store, task];
          return Result.ok(undefined);
        },
        async saveAll(_sprintId: SprintId, tasks: readonly Task[]) {
          store = [...tasks];
          saveAlls.push(tasks);
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      tasks: () => store,
      get saveAlls() {
        return saveAlls;
      },
    };
  };

  // ─── Real-file-writing fake AI provider ───────────────────────────────────
  /**
   * For the parallel path the `session.cwd` is the WORKTREE PATH (not the main repo root).
   * When "generating", the fake writes a distinct file under `session.cwd` so the real git
   * commit leaf finds a dirty tree, stages, and commits it. This exercises the full real-git
   * commit path inside each worktree.
   *
   * For the evaluator the fake just emits `evaluationPassed` — no file write needed (the
   * evaluator runs in a read-only posture and doesn't need to land any new files for the
   * chain to advance).
   */
  const MARKERS = {
    implement: '# Task Execution Protocol',
    evaluate: 'independent code reviewer',
  } as const;

  const taskVerified = (output: string): HarnessSignal => ({ type: 'task-verified', output, timestamp: FIXED_NOW });
  const evaluationPassed = (): HarnessSignal => ({
    type: 'evaluation',
    status: 'passed',
    // Full floor set — a terminal PASS must grade all four floor dimensions per the signal schema.
    dimensions: [
      { dimension: 'correctness', passed: true, finding: 'all good' },
      { dimension: 'completeness', passed: true, finding: 'steps shipped' },
      { dimension: 'safety', passed: true, finding: 'inputs validated' },
      { dimension: 'consistency', passed: true, finding: 'matches siblings' },
    ],
    timestamp: FIXED_NOW,
  });

  interface RealFileWritingFakeProvider extends HeadlessAiProvider {
    readonly recordedCwds: string[];
  }

  /**
   * Fake provider that:
   *  - On `implement` prompt: writes `<task-file-prefix>.txt` into `session.cwd` (the worktree
   *    dir in the parallel path) so real git sees a dirty tree, and emits `taskVerified`.
   *  - On `evaluate` prompt: emits `evaluationPassed` only (no file write needed).
   *
   * `taskFilePrefix` is unique per task so sibling tasks don't write the same filename and
   * create false conflicts on the fold step — we want clean folds in the happy path.
   */
  const createRealFileWritingProvider = (taskFilePrefix: string): RealFileWritingFakeProvider => {
    const recordedCwds: string[] = [];
    return {
      recordedCwds,
      async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
        recordedCwds.push(String(session.cwd));

        const prompt = session.prompt;
        const isImplement = prompt.includes(MARKERS.implement);
        const isEvaluate = prompt.includes(MARKERS.evaluate);

        let signals: HarnessSignal[];

        if (isImplement) {
          // Write a REAL file so git sees a dirty worktree and the commit leaf lands.
          const targetFile = join(String(session.cwd), `${taskFilePrefix}.txt`);
          await fs.writeFile(targetFile, `Task ${taskFilePrefix} output written by fake AI\n`, 'utf8');
          signals = [taskVerified(`${taskFilePrefix} done`)];
        } else if (isEvaluate) {
          signals = [evaluationPassed()];
        } else {
          // Unknown prompt — emit empty signals (will surface as a non-fatal failure; test
          // will catch this via the final status assertion rather than a hard throw).
          signals = [];
        }

        const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
        if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;

        return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 }) as Result<ProviderOutput, DomainError>;
      },
    };
  };

  // ─── Recording shell script runner ───────────────────────────────────────
  /**
   * A ShellScriptRunner spy that records every (cwd, script) call it receives and always
   * returns `passed: true`. Tests can inspect `calls` after a run to assert which cwds the
   * harness invoked setup in (e.g. to prove per-worktree setup ran inside each worktree, not
   * inside the main repo).
   */
  interface RecordingShellCall {
    readonly cwd: string;
    readonly script: string;
  }
  interface RecordingShellScriptRunner extends ShellScriptRunner {
    readonly calls: readonly RecordingShellCall[];
  }
  const createRecordingShell = (): RecordingShellScriptRunner => {
    const calls: RecordingShellCall[] = [];
    return {
      get calls(): readonly RecordingShellCall[] {
        return calls;
      },
      async run(
        cwd: AbsolutePath,
        script: string
      ): Promise<Result<{ passed: boolean; exitCode: number; output: string; durationMs: number }, StorageError>> {
        calls.push({ cwd: String(cwd), script });
        return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
      },
    };
  };
  /** Backwards-compatible pass-through for tests that don't need call recording. */
  const passingShell: ShellScriptRunner = createRecordingShell();

  // ─── Fixture setup helpers ────────────────────────────────────────────────
  interface ParallelFixture {
    readonly repo: FakeProject;
    readonly sprintDir: string;
    readonly progressFile: string;
    readonly ralphctlRoot: string;
    readonly memoryRoot: string;
    cleanup(): Promise<void>;
  }

  const buildParallelFixture = async (): Promise<ParallelFixture> => {
    const repo = await createFakeProject({
      seed: {
        'README.md': '# parallel-test-repo\n',
        '.gitignore': 'node_modules/\n',
      },
    });

    // Create and check out the sprint branch in the real repo.
    await repo.git('checkout', '-b', SPRINT_BRANCH);

    // Directory for ralphctl state (sprint dir, locks, etc.)
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-parallel-state-'));
    const ralphctlRoot = await realpath(raw);
    const sprintDir = join(ralphctlRoot, 'sprint');
    const progressFile = join(sprintDir, 'progress.md');
    // Per-run, under the same unique mkdtemp root → no shared `/tmp` path, no cross-exec
    // collision on the learnings ledger, and torn down with `ralphctlRoot` in cleanup.
    const memoryRoot = join(ralphctlRoot, 'memory');
    await fs.mkdir(sprintDir, { recursive: true });
    await fs.mkdir(memoryRoot, { recursive: true });

    return {
      repo,
      sprintDir,
      progressFile,
      ralphctlRoot,
      memoryRoot,
      async cleanup() {
        await repo.cleanup();
        await fs.rm(ralphctlRoot, { recursive: true, force: true });
      },
    };
  };

  // ─── Build ImplementDeps using a REAL GitRunner ───────────────────────────
  const buildRealGitDeps = (
    sprintRepo: SprintRepository,
    executionRepo: SprintExecutionRepository,
    taskRepo: TaskRepository,
    provider: HeadlessAiProvider,
    locksRootPath: string,
    shellScriptRunner: ShellScriptRunner = passingShell
  ): ImplementDeps => {
    const realGit = createGitRunner();
    return {
      sprintRepo,
      sprintExecutionRepo: executionRepo,
      taskRepo,
      generatorProvider: provider,
      evaluatorProvider: provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      signals: createInMemorySink<HarnessSignal>(),
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      clock: () => FIXED_LATER,
      config: {
        harness: {
          maxTurns: 5,
          maxAttempts: 1,
          rateLimitRetries: 0,
          plateauThreshold: 2,
          escalateOnPlateau: false,
          escalationMap: {},
        },
      },
      gitRunner: realGit,
      shellScriptRunner,
      fileLocker: createFileLocker(),
      locksRoot: absolutePath(locksRootPath),
      skillsAdapter: noopSkillsAdapter,
      skillSource: emptySkillSource,
      interactive: {
        async askText() {
          throw new Error('askText not expected in parallel real-git test');
        },
        async askTextArea() {
          throw new Error('askTextArea not expected');
        },
        async askChoice() {
          throw new Error('askChoice not expected — sprint branch is pre-set');
        },
        async askMultiChoice() {
          throw new Error('askMultiChoice not expected');
        },
        async askConfirm() {
          throw new Error('askConfirm not expected');
        },
      },
      writeFile: createAtomicWriteFile(),
      appendFile: createAppendFile(),
    };
  };

  // ─── Parse AbsolutePath safely ────────────────────────────────────────────
  const ap = (s: string): AbsolutePath => {
    const r = AbsolutePath.parse(s);
    if (!r.ok) throw new Error(`absolutePath parse failed: ${r.error.message}`);
    return r.value;
  };

  // ─── Count commits on a branch ────────────────────────────────────────────
  const countCommitsOnBranch = async (repoPath: string, branch: string): Promise<number> => {
    const { execSync } = await import('node:child_process');
    const out = execSync(`git -C "${repoPath}" log --oneline "${branch}"`, { encoding: 'utf8' });
    const lines = out
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    return lines.length;
  };

  const listWorktrees = async (repoPath: string): Promise<string[]> => {
    const { execSync } = await import('node:child_process');
    const out = execSync(`git -C "${repoPath}" worktree list --porcelain`, { encoding: 'utf8' });
    // Each worktree block starts with "worktree <path>". The first entry is the main worktree.
    return out
      .split('\n\n')
      .map((block) => {
        const line = block.trim().split('\n')[0] ?? '';
        return line.startsWith('worktree ') ? line.slice('worktree '.length).trim() : '';
      })
      .filter((p) => p.length > 0);
  };

  const getCommitFiles = async (repoPath: string, branch: string): Promise<string[]> => {
    const { execSync } = await import('node:child_process');
    // Get all files added across ALL commits on this branch (excluding the initial commit)
    // by listing files added by each commit after the initial one.
    const log = execSync(`git -C "${repoPath}" log --name-only --format="%H" "${branch}"`, { encoding: 'utf8' });
    const lines = log
      .trim()
      .split('\n')
      .filter((l) => l.length > 0 && !l.match(/^[0-9a-f]{40}/));
    return lines;
  };

  // ─── Tests ────────────────────────────────────────────────────────────────
  describe('parallel implement — real git worktrees', () => {
    let cleanupFns: Array<() => Promise<void>>;

    beforeEach(() => {
      cleanupFns = [];
    });

    afterEach(async () => {
      for (const fn of cleanupFns) await fn().catch(() => undefined);
    });

    it('happy path: 3 tasks in 2 waves all settle done, 3 real commits on sprint branch, worktrees cleaned up', async () => {
      const fixture = await buildParallelFixture();
      cleanupFns.push(() => fixture.cleanup());

      const repoPath = fixture.repo.path;
      const sprintDirPath = ap(fixture.sprintDir);
      const progressPath = ap(fixture.progressFile);

      // ── Domain fixtures ────────────────────────────────────────────────
      const ticket = makeApprovedTicket({ title: 'parallel-test-ticket' });
      const sprint = makePlannedSprint({ tickets: [ticket] });
      // Pre-set the sprint branch so resolveBranchLeaf takes the resume path without prompting.
      const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), SPRINT_BRANCH);

      // 3 tasks: A (order 1, no deps), B (order 2, no deps), C (order 3, depends on A)
      // → wave 0 = {A, B}, wave 1 = {C}
      const taskA = makeTodoTask({
        name: 'task-a',
        order: 1,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
      });
      const taskB = makeTodoTask({
        name: 'task-b',
        order: 2,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
      });
      const taskC = makeTodoTask({
        name: 'task-c',
        order: 3,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
        dependsOn: [taskA.id],
      });
      const tasks = [taskA, taskB, taskC];

      const sprintStore = inMemorySprintRepo(sprint);
      const execStore = inMemoryExecutionRepo(execution);
      const taskStore = inMemoryTaskRepo(tasks);

      // One fake provider per task so each writes a distinct file, enabling clean ff folds.
      const providerA = createRealFileWritingProvider('task-a-output');
      const providerB = createRealFileWritingProvider('task-b-output');
      const providerC = createRealFileWritingProvider('task-c-output');

      // The parallel path builds per-task subchains; each subchain gets its own branch-specific
      // provider injected via the branch's ImplementDeps. We need a single ImplementDeps for the
      // prologue/epilogue, then per-branch overrides for the per-task bodies.
      // The design uses the SAME provider pair injected into ImplementDeps for all branches by
      // default (wave-branch.ts clones deps, overriding only signals). To inject per-task providers,
      // we build a combined provider that dispatches by task name embedded in session.cwd.
      const combinedProvider: HeadlessAiProvider = {
        async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
          // The session.cwd is the worktree path: <sprintDir>/worktrees/wt-<taskId>
          // Use it to identify the task. The fake file-writing providers are keyed on the
          // task file prefix which embeds the task name. We dispatch based on cwd suffix.
          const cwd = String(session.cwd);
          const taskIdA = String(taskA.id);
          const taskIdB = String(taskB.id);
          const taskIdC = String(taskC.id);

          if (cwd.includes(`wt-${taskIdA}`)) return providerA.generate(session);
          if (cwd.includes(`wt-${taskIdB}`)) return providerB.generate(session);
          if (cwd.includes(`wt-${taskIdC}`)) return providerC.generate(session);

          // Prologue/epilogue steps that call the provider (e.g. detect-scripts) don't exist
          // in the implement path — if we hit this, something unexpected called generate.
          // Also: for the serial flow fixture baseline the deps use FAKE_CWD — use providerA
          // as fallback for any non-worktree cwd (shouldn't fire in parallel path).
          return providerA.generate(session);
        },
      };

      const locksRoot = join(fixture.ralphctlRoot, 'locks');
      await fs.mkdir(locksRoot, { recursive: true });

      // Recording shell runner — spy on which cwds the harness invokes setup in.
      const recordingShell = createRecordingShell();

      const implementDeps = buildRealGitDeps(
        sprintStore.repo,
        execStore.repo,
        taskStore.repo,
        combinedProvider,
        locksRoot,
        recordingShell
      );

      // Repository map pointing at the REAL repo — with a sentinel setupScript so we can prove
      // per-worktree setup ran inside each worktree. The script just echoes a line; the
      // recording shell intercepts the call and records the cwd without actually running anything.
      const SETUP_SCRIPT = 'echo ralphctl-setup-ran';
      const repoMap = new Map([
        [FIXED_REPOSITORY_ID, { path: ap(repoPath), name: 'test-repo', setupScript: SETUP_SCRIPT } as RepoExecConfig],
      ]);

      const implementOpts = {
        sprintId: sprint.id,
        todoTasks: tasks,
        repositories: repoMap,
        progressFile: progressPath,
        sprintDir: sprintDirPath,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        memoryRoot: ap(fixture.memoryRoot),
        projectId: FAKE_PROJECT_ID,
        // Skip the interactive dirty-tree menu — we own the repo and it's clean.
        dirtyTreePolicy: 'cancel' as const,
      };

      // Build the plan (prologue / waves / epilogue)
      const plan = planImplementWaves(implementDeps, implementOpts);

      // Verify the wave structure: wave 0 = {A, B}, wave 1 = {C}
      expect(plan.waves).toHaveLength(2);
      expect(plan.waves[0]).toHaveLength(2);
      expect(plan.waves[1]).toHaveLength(1);
      expect(plan.waves[0]?.[0]?.name).toBe('task-a');
      expect(plan.waves[0]?.[1]?.name).toBe('task-b');
      expect(plan.waves[1]?.[0]?.name).toBe('task-c');

      const foldQueue = createFoldQueue();
      const branchDeps = {
        implement: implementDeps,
        appSignals: createInMemorySink<HarnessSignal>(),
        eventBus: createInMemoryEventBus(),
        foldQueue,
      };

      const readConfig = () =>
        Promise.resolve({
          maxTurns: 5,
          escalateOnPlateau: false,
          escalationMap: {} as Record<string, string>,
          maxAttempts: 3,
        });

      const parallelElement = createParallelImplementElement(plan, {
        fileLocker: implementDeps.fileLocker,
        locksRoot: implementDeps.locksRoot,
        eventBus: implementDeps.eventBus,
        maxConcurrency: 3,
        flowId: 'implement',
        sessionId: () => `session-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
        buildWaves: () => buildWaveBranches(branchDeps, implementOpts, plan.waves, readConfig),
      });

      const runner = createRunner<ImplementCtx>({
        id: 'r-parallel-realgit-happy',
        element: parallelElement,
        initialCtx: { sprintId: sprint.id },
      });

      await runner.start();

      // ── Assert runner completed ────────────────────────────────────────
      if (runner.status !== 'completed') {
        const trace = runner.trace.map((e) => `${e.elementName}:${e.status}`).join('\n');
        throw new Error(`Runner status is '${runner.status}' — expected 'completed'.\nTrace:\n${trace}`);
      }
      expect(runner.status).toBe('completed');

      // ── Assert all 3 tasks are done ────────────────────────────────────
      const finalTasks = taskStore.tasks();
      expect(finalTasks).toHaveLength(3);
      for (const t of finalTasks) {
        expect(t.status).toBe('done');
      }

      // ── Assert sprint transitioned to review ───────────────────────────
      expect(sprintStore.current().status).toBe('review');

      // ── Assert 3 real commits on the sprint branch ─────────────────────
      // Initial commit + 3 task commits = 4 total. (The initial commit was 'chore: initial commit'
      // from createFakeProject; the sprint branch started from there.) Wave 0 folds tasks A+B
      // (one ff, one cherry-pick); wave 1 folds task C.
      const commitCount = await countCommitsOnBranch(repoPath, SPRINT_BRANCH);
      // 1 initial + 3 task commits
      expect(commitCount).toBe(4);

      // ── Assert each task's file exists on the sprint branch ────────────
      const committedFiles = await getCommitFiles(repoPath, SPRINT_BRANCH);
      expect(committedFiles.some((f) => f.includes('task-a-output.txt'))).toBe(true);
      expect(committedFiles.some((f) => f.includes('task-b-output.txt'))).toBe(true);
      expect(committedFiles.some((f) => f.includes('task-c-output.txt'))).toBe(true);

      // ── Assert task-c comes AFTER task-a in the commit log ────────────
      // (wave ordering: A and B must be committed before C)
      const { execSync } = await import('node:child_process');
      const logOrder = execSync(`git -C "${repoPath}" log --name-only --format="%s" "${SPRINT_BRANCH}"`, {
        encoding: 'utf8',
      });
      // git log is newest-first, so C should appear before A/B
      const idxA = logOrder.indexOf('task-a-output.txt');
      const idxB = logOrder.indexOf('task-b-output.txt');
      const idxC = logOrder.indexOf('task-c-output.txt');
      expect(idxC).toBeGreaterThan(-1);
      expect(idxA).toBeGreaterThan(-1);
      expect(idxB).toBeGreaterThan(-1);
      // C is newest (latest commit) so it appears EARLIER in git log (lower index).
      // A and B from wave 0 appear later (higher index, older).
      // Wave ordering: C came after A, so C should appear before A in git log (newest-first).
      // (This may vary if cherry-pick changes order — but wave-sequential execution guarantees
      //  wave 0 (A,B) lands before wave 1 (C) starts.)
      expect(idxC).toBeLessThan(idxA);
      expect(idxC).toBeLessThan(idxB);

      // ── Assert worktrees cleaned up ────────────────────────────────────
      // After the run completes, `git worktree list` should show ONLY the main worktree.
      const worktrees = await listWorktrees(repoPath);
      expect(worktrees).toHaveLength(1);
      // The single remaining worktree should be the main repo root.
      expect(worktrees[0]).toBe(repoPath);

      // ── Regression: the throwaway wt-* branch refs are deleted on cleanup ──
      //
      // `git worktree remove --force <path>` drops the worktree directory + its
      // `.git/worktrees/<name>` record but LEAVES the branch `git worktree add -b <ref>` created.
      // Stale `ralphctl/<sprint>/wt-<taskId>` refs would then accumulate and — worse — make a
      // relaunch after an aborted task fail (`worktree add -b <same-ref>` errors "branch exists").
      // `cleanupWorktree` now calls `gitDeleteBranch` (best-effort) after a successful remove.
      // This real-git test is what caught the original miss; the fake-GitRunner unit tests could not.
      const branchListRaw = execSync(`git -C "${repoPath}" branch -a`, { encoding: 'utf8' });
      const taskIds = [String(taskA.id), String(taskB.id), String(taskC.id)];
      for (const taskId of taskIds) {
        expect(branchListRaw).not.toContain(`wt-${taskId}`);
      }

      // ── Assert main working tree is clean and was never stashed ────────
      const statusOut = execSync(`git -C "${repoPath}" status --porcelain`, { encoding: 'utf8' });
      expect(statusOut.trim()).toBe('');

      const stashList = execSync(`git -C "${repoPath}" stash list`, { encoding: 'utf8' });
      expect(stashList.trim()).toBe('');

      // ── Assert per-worktree setup script ran inside each worktree ───────
      //
      // The recording shell spy intercepts every `shellScriptRunner.run()` call:
      //   - 1 call from the prologue's `setupScriptRunnerLeaf` (main repo, cwd = repoPath)
      //   - 3 calls from `wave-branch.ts` `runWorktreeSetupScript` (one per task, each in its
      //     own worktree directory)
      // Total = 4. The 3 worktree calls prove per-worktree setup ran inside each worktree, NOT
      // in the main repo root. Setup running in the wrong cwd would be a regression: the worktree
      // is an isolated checkout that may have missing build artifacts, and setup must prep THAT
      // tree, not the one already set up by the prologue.
      expect(recordingShell.calls).toHaveLength(4);
      for (const call of recordingShell.calls) {
        expect(call.script).toBe(SETUP_SCRIPT);
      }
      // Exactly 1 call in the main repo root (prologue).
      const prologueCalls = recordingShell.calls.filter((c) => c.cwd === repoPath);
      expect(prologueCalls).toHaveLength(1);
      // Exactly 3 calls in worktree paths (per-worktree setup).
      const worktreeCalls = recordingShell.calls.filter((c) => c.cwd.includes('worktrees/wt-'));
      expect(worktreeCalls).toHaveLength(3);
      // One distinct worktree path per task (no two tasks share a worktree).
      const worktreeCwds = new Set(worktreeCalls.map((c) => c.cwd));
      expect(worktreeCwds.size).toBe(3);

      // ── Assert sprint branch is a single linear chain (no merge commits) ─
      //
      // The fold logic uses `git merge --ff-only` (fast-forward) or `git cherry-pick` — neither
      // produces a merge commit. A merge commit would mean the worktree was merged with a
      // real `git merge`, which would violate the "preserve linear history" contract.
      const mergeCommits = execSync(`git -C "${repoPath}" log --merges --oneline "${SPRINT_BRANCH}"`, {
        encoding: 'utf8',
      }).trim();
      expect(mergeCommits).toBe('');
    }, 120_000); // This test involves real git operations (worktree add × 3) — give it generous headroom.

    it('abort mid-run: worktrees are cleaned up and sprint stays runnable (tasks reset to todo)', async () => {
      const fixture = await buildParallelFixture();
      cleanupFns.push(() => fixture.cleanup());

      const repoPath = fixture.repo.path;
      const sprintDirPath = ap(fixture.sprintDir);
      const progressPath = ap(fixture.progressFile);

      const ticket = makeApprovedTicket({ title: 'abort-test-ticket' });
      const sprint = makePlannedSprint({ tickets: [ticket] });
      const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), SPRINT_BRANCH);

      // Two independent tasks — wave 0 = {A, B}. We abort after the worktrees are set up.
      const taskA = makeTodoTask({
        name: 'abort-task-a',
        order: 1,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
      });
      const taskB = makeTodoTask({
        name: 'abort-task-b',
        order: 2,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
      });
      const tasks = [taskA, taskB];

      const sprintStore = inMemorySprintRepo(sprint);
      const execStore = inMemoryExecutionRepo(execution);
      const taskStore = inMemoryTaskRepo(tasks);

      // Abort controller — we fire it after the AI starts (during generate())
      const abortController = new AbortController();

      // Slow provider: blocks until aborted, then returns an error.
      // This keeps branches in-flight long enough for the abort signal to fire.
      let generateCallCount = 0;
      const slowAbortableProvider: HeadlessAiProvider = {
        async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
          generateCallCount += 1;
          // On the first generate call, trigger the abort immediately.
          if (generateCallCount === 1) {
            abortController.abort();
          }
          // Simulate time passing — the abort should arrive while we're "thinking."
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          // Write a file and emit signals so the chain CAN complete if not aborted.
          const targetFile = join(String(session.cwd), `abort-test-output-${String(generateCallCount)}.txt`);
          await fs.writeFile(targetFile, 'abort test\n', 'utf8');
          const signals: HarnessSignal[] = [taskVerified('abort test')];
          const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
          if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;
          return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 }) as Result<ProviderOutput, DomainError>;
        },
      };

      const locksRoot = join(fixture.ralphctlRoot, 'locks');
      await fs.mkdir(locksRoot, { recursive: true });

      const implementDeps = buildRealGitDeps(
        sprintStore.repo,
        execStore.repo,
        taskStore.repo,
        slowAbortableProvider,
        locksRoot
      );
      const repoMap = new Map([[FIXED_REPOSITORY_ID, { path: ap(repoPath), name: 'test-repo' } as RepoExecConfig]]);

      const implementOpts = {
        sprintId: sprint.id,
        todoTasks: tasks,
        repositories: repoMap,
        progressFile: progressPath,
        sprintDir: sprintDirPath,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        memoryRoot: ap(fixture.memoryRoot),
        projectId: FAKE_PROJECT_ID,
        dirtyTreePolicy: 'cancel' as const,
      };

      const plan = planImplementWaves(implementDeps, implementOpts);
      const foldQueue = createFoldQueue();
      const branchDeps = {
        implement: implementDeps,
        appSignals: createInMemorySink<HarnessSignal>(),
        eventBus: createInMemoryEventBus(),
        foldQueue,
      };

      const readConfig = () =>
        Promise.resolve({
          maxTurns: 5,
          escalateOnPlateau: false,
          escalationMap: {} as Record<string, string>,
          maxAttempts: 3,
        });

      const parallelElement = createParallelImplementElement(plan, {
        fileLocker: implementDeps.fileLocker,
        locksRoot: implementDeps.locksRoot,
        eventBus: implementDeps.eventBus,
        maxConcurrency: 3,
        flowId: 'implement',
        sessionId: () => `session-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
        buildWaves: () => buildWaveBranches(branchDeps, implementOpts, plan.waves, readConfig),
      });

      const runner = createRunner<ImplementCtx>({
        id: 'r-parallel-realgit-abort',
        element: parallelElement,
        initialCtx: { sprintId: sprint.id },
      });

      // Pass abort signal to runner.start() — when the runner starts, forward abort.
      const runnerAbortController = new AbortController();
      const externalSignal = abortController.signal;
      externalSignal.addEventListener('abort', () => runner.abort('test-abort'), { once: true });

      await runner.start();

      // The runner should be aborted (or in some cases completed if abort raced a finish).
      // Either way: worktrees MUST be cleaned up.
      const worktrees = await listWorktrees(repoPath);
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]).toBe(repoPath);

      // The main working tree must be clean (no stash).
      const { execSync } = await import('node:child_process');
      const statusOut = execSync(`git -C "${repoPath}" status --porcelain`, { encoding: 'utf8' });
      expect(statusOut.trim()).toBe('');
      const stashList = execSync(`git -C "${repoPath}" stash list`, { encoding: 'utf8' });
      expect(stashList.trim()).toBe('');

      // Sprint must NOT have transitioned to review on abort (it's still active or planned).
      expect(sprintStore.current().status).not.toBe('review');

      void runnerAbortController;
    }, 90_000);

    it('fold conflict adversarial: task B conflicts on fold → B blocked, A stays done, sprint branch clean and linear', async () => {
      //
      // Setup:
      //   1. Initial commit seeds `shared.txt` = "original content\n".
      //   2. Task A (wave 0, order 1): overwrites `shared.txt` with "modified by task-a\n"
      //      and commits. Folds first via ff-only (sprint branch had not advanced yet) —
      //      the sprint branch now points at A's commit.
      //   3. Task B (wave 0, order 2): ALSO overwrites `shared.txt` with "modified by task-b\n"
      //      and commits. Its worktree forked from the sprint-branch tip BEFORE A's fold, so
      //      `git merge --ff-only` fails (branch has advanced). `gitFoldBranch` then tries
      //      `git cherry-pick <merge-base>..wt-B` — conflict on `shared.txt`. Cherry-pick is
      //      aborted; sprint branch is left clean with only A's commit.
      //
      // Assertions:
      //   - Task A: `done`
      //   - Task B: `blocked`, blockedReason contains "fold conflict"
      //   - Sprint branch: only A's commit (not B's), no merge commits, clean working tree
      //   - Worktrees: cleaned up (only main worktree)
      //   - No stale wt-* branch refs
      //   - Sprint status: transitions to `review` (the wave completed — A landed done, B blocked)
      //
      const fixture = await buildParallelFixture();
      cleanupFns.push(() => fixture.cleanup());

      const repoPath = fixture.repo.path;
      const sprintDirPath = ap(fixture.sprintDir);
      const progressPath = ap(fixture.progressFile);

      // Seed `shared.txt` on the sprint branch (the fixture already checked it out).
      // Both tasks will overwrite this file, creating a real cherry-pick conflict when
      // the second one tries to fold — it cannot fast-forward because task A already advanced
      // the sprint branch pointer, and cherry-pick of task B's commit will conflict on this file.
      await fixture.repo.writeFile('shared.txt', 'original content\n');
      await fixture.repo.git('add', 'shared.txt');
      await fixture.repo.git('commit', '-m', 'chore: seed shared.txt');

      const ticket = makeApprovedTicket({ title: 'conflict-test-ticket' });
      const sprint = makePlannedSprint({ tickets: [ticket] });
      const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), SPRINT_BRANCH);

      // Two tasks in wave 0 (no dependency edge between them) targeting the same repo.
      // Task A (order 1) folds first; task B (order 2) conflicts.
      const taskA = makeTodoTask({
        name: 'conflict-task-a',
        order: 1,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
      });
      const taskB = makeTodoTask({
        name: 'conflict-task-b',
        order: 2,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
      });
      const tasks = [taskA, taskB];

      const sprintStore = inMemorySprintRepo(sprint);
      const execStore = inMemoryExecutionRepo(execution);
      const taskStore = inMemoryTaskRepo(tasks);

      // Fake provider: both tasks write to the SAME file (`shared.txt`) with conflicting content.
      // No additional unique file — the conflict on `shared.txt` must be real.
      const conflictProvider: HeadlessAiProvider = {
        async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
          const prompt = session.prompt;
          const isEvaluate = prompt.includes(MARKERS.evaluate);

          let signals: HarnessSignal[];

          if (isEvaluate) {
            signals = [evaluationPassed()];
          } else {
            // Both tasks overwrite `shared.txt` with DIFFERENT content — this is the conflict.
            // Task A writes "modified by task-a\n"; task B writes "modified by task-b\n".
            // Their worktrees both forked from the same initial sprint-branch tip, so when
            // task A folds (ff-only), the sprint branch advances. Task B's cherry-pick then
            // conflicts on `shared.txt`.
            const cwd = String(session.cwd);
            const isTaskA = cwd.includes(`wt-${String(taskA.id)}`);
            const sharedFile = join(cwd, 'shared.txt');
            const content = isTaskA ? 'modified by task-a\n' : 'modified by task-b\n';
            await fs.writeFile(sharedFile, content, 'utf8');
            const taskName = isTaskA ? 'task-a' : 'task-b';
            signals = [taskVerified(`${taskName} done`)];
          }

          const wrote = await writeJsonAtomic(String(session.signalsFile), signals);
          if (!wrote.ok) return Result.error(wrote.error) as Result<ProviderOutput, DomainError>;
          return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 }) as Result<ProviderOutput, DomainError>;
        },
      };

      const locksRoot = join(fixture.ralphctlRoot, 'locks');
      await fs.mkdir(locksRoot, { recursive: true });

      const implementDeps = buildRealGitDeps(
        sprintStore.repo,
        execStore.repo,
        taskStore.repo,
        conflictProvider,
        locksRoot
      );

      // No setupScript — the conflict scenario doesn't need per-worktree setup.
      const repoMap = new Map([[FIXED_REPOSITORY_ID, { path: ap(repoPath), name: 'test-repo' } as RepoExecConfig]]);

      const implementOpts = {
        sprintId: sprint.id,
        todoTasks: tasks,
        repositories: repoMap,
        progressFile: progressPath,
        sprintDir: sprintDirPath,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        memoryRoot: ap(fixture.memoryRoot),
        projectId: FAKE_PROJECT_ID,
        dirtyTreePolicy: 'cancel' as const,
      };

      const plan = planImplementWaves(implementDeps, implementOpts);

      // Confirm both tasks landed in wave 0 (no dependency edge — same wave).
      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0]).toHaveLength(2);

      const foldQueue = createFoldQueue();
      const branchDeps = {
        implement: implementDeps,
        appSignals: createInMemorySink<HarnessSignal>(),
        eventBus: createInMemoryEventBus(),
        foldQueue,
      };

      const readConfig = () =>
        Promise.resolve({
          maxTurns: 5,
          escalateOnPlateau: false,
          escalationMap: {} as Record<string, string>,
          maxAttempts: 3,
        });

      const parallelElement = createParallelImplementElement(plan, {
        fileLocker: implementDeps.fileLocker,
        locksRoot: implementDeps.locksRoot,
        eventBus: implementDeps.eventBus,
        maxConcurrency: 3,
        flowId: 'implement',
        sessionId: () => `session-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
        buildWaves: () => buildWaveBranches(branchDeps, implementOpts, plan.waves, readConfig),
      });

      const runner = createRunner<ImplementCtx>({
        id: 'r-parallel-realgit-conflict',
        element: parallelElement,
        initialCtx: { sprintId: sprint.id },
      });

      await runner.start();

      // Runner must complete (never error/abort) — a fold conflict is a domain block, not a chain failure.
      if (runner.status !== 'completed') {
        const trace = runner.trace.map((e) => `${e.elementName}:${e.status}`).join('\n');
        throw new Error(`Runner status is '${runner.status}' — expected 'completed'.\nTrace:\n${trace}`);
      }
      expect(runner.status).toBe('completed');

      const finalTasks = taskStore.tasks();
      expect(finalTasks).toHaveLength(2);

      const finalA = finalTasks.find((t) => t.id === taskA.id);
      const finalB = finalTasks.find((t) => t.id === taskB.id);

      // Both tasks run concurrently in wave 0. The fold queue is FIFO: whichever task's
      // subchain completes first wins the ff-only merge and lands `done`; the other's
      // cherry-pick conflicts → `blocked`. Since both tasks wrote the SAME file with
      // DIFFERENT content, exactly one must land and the other must conflict.
      //
      // We cannot predict which task folds first (it depends on goroutine scheduling),
      // so we assert the OUTCOME invariants rather than task-specific statuses.
      const doneTask = finalTasks.find((t) => t.status === 'done');
      const blockedTask = finalTasks.find((t) => t.status === 'blocked');

      // Exactly one task must be done and exactly one must be blocked.
      expect(doneTask).toBeDefined();
      expect(blockedTask).toBeDefined();
      // The blocked task's reason must mention the conflict so the operator knows what happened.
      if (blockedTask?.status === 'blocked') {
        expect(blockedTask.blockedReason).toMatch(/fold conflict/i);
      }

      // Sanity: both tasks must have settled (neither still todo or in_progress).
      expect(finalA?.status).not.toBe('todo');
      expect(finalA?.status).not.toBe('in_progress');
      expect(finalB?.status).not.toBe('todo');
      expect(finalB?.status).not.toBe('in_progress');

      const { execSync } = await import('node:child_process');

      // The content on the sprint branch must be whichever task folded first.
      // It must be one of the two values — not the original seed content (which was overwritten)
      // and not a conflict marker (which would mean cherry-pick --abort didn't run).
      const sharedContent = execSync(`git -C "${repoPath}" show "${SPRINT_BRANCH}:shared.txt"`, {
        encoding: 'utf8',
      });
      const taskAContent = 'modified by task-a';
      const taskBContent = 'modified by task-b';
      const landedContent = sharedContent.trim();
      expect([taskAContent, taskBContent]).toContain(landedContent);

      // The folded content must correspond to the task that ended `done`.
      // If task A is done, sprint branch must have task A's content (and vice versa).
      const expectedContent = doneTask?.id === taskA.id ? taskAContent : taskBContent;
      expect(landedContent).toBe(expectedContent);

      // Sprint branch must be clean (no in-progress cherry-pick state).
      const cherryPickHead = join(repoPath, '.git', 'CHERRY_PICK_HEAD');
      await expect(fs.access(cherryPickHead)).rejects.toThrow(); // file must not exist

      const statusOut = execSync(`git -C "${repoPath}" status --porcelain`, { encoding: 'utf8' });
      expect(statusOut.trim()).toBe('');

      // No merge commits — history is still linear.
      const mergeCommits = execSync(`git -C "${repoPath}" log --merges --oneline "${SPRINT_BRANCH}"`, {
        encoding: 'utf8',
      }).trim();
      expect(mergeCommits).toBe('');

      // Worktrees cleaned up.
      const worktrees = await listWorktrees(repoPath);
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]).toBe(repoPath);

      // No stale wt-* branch refs.
      const branchListRaw = execSync(`git -C "${repoPath}" branch -a`, { encoding: 'utf8' });
      expect(branchListRaw).not.toContain(`wt-${String(taskA.id)}`);
      expect(branchListRaw).not.toContain(`wt-${String(taskB.id)}`);

      // Sprint transitions to review: wave completed (A done, B blocked — both tasks settled).
      expect(sprintStore.current().status).toBe('review');
    }, 120_000);
  });
}
