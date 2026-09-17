/**
 * Real-git end-to-end test for relaunching a defect-shaped task after an unblock.
 *
 * An earlier launch reproduced the defect, got part of the way to a fix and blocked. Its whole
 * uncommitted work — the failing reproduction test included — went into the quarantine stash, and
 * the validated reproduction was saved under the task's workspace. The operator unblocked the task
 * and launched again.
 *
 * The relaunch has to continue from that work. Spawning a fresh reproduce session would write a new
 * failing test into the tree, and the restore only ever pops onto a clean tree, so the earlier work
 * would stay in the stash for good. These cases pin, against real git, that the relaunch reuses the
 * saved reproduction instead, measures the baseline on HEAD, and only then pops the earlier work.
 *
 * What is faked: the AI provider (writes real files into the session cwd), the shell runner (a
 * verify script that fails while the reproduction test sees the unfixed code), and the in-memory
 * repositories. Git is real.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { HeadlessAiProvider, ProviderOutput } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { writeJsonAtomic } from '@src/integration/io/fs.ts';
import { createGitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { createImplementFlow, type RepoExecConfig } from '@src/application/flows/implement/flow.ts';
import { buildWaveBranches, createFoldQueue } from '@src/application/flows/implement/wave-branch.ts';
import { quarantineStashMessage } from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import { REPRODUCTION_TAMPER_NOTE } from '@src/application/flows/implement/leaves/reproduce.ts';
import {
  absolutePath,
  FIXED_LATER,
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
  slug,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';
import { noopAgentDefinitionAdapter } from '@tests/fixtures/agent-definition-fakes.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';

if (process.platform === 'win32') {
  describe.skip('bugfix relaunch — real git (skipped on Windows)', () => {
    it.skip('placeholder', () => undefined);
  });
} else {
  runTests();
}

function runTests(): void {
  const SPRINT_BRANCH = 'ralphctl/bugfix-relaunch';
  const SOURCE_PATH = 'src/foo.ts';
  const TEST_PATH = 'tests/unit/foo.test.ts';
  const RUN_COMMAND = 'npx vitest run tests/unit/foo.test.ts';
  const VERIFY_SCRIPT = 'run-verify';
  const SAVED_FAILURE = 'Error: foo() returned BUG (earlier launch)';

  const SOURCE_AT_HEAD = "export const foo = (): string => 'BUG';\n";
  const TEST_AT_HEAD = "it('keeps the existing case', () => {});\n";
  // The earlier launch's reproduction test (C1) and its partial fix.
  const REPRO_TEST = `${TEST_AT_HEAD}it('REPRO: foo() never returns BUG', () => {});\n`;
  const PARTIAL_SOURCE = "export const foo = (): string => 'BUG'; // PARTIAL\n";
  // What a fresh reproduce session would write (C2) — the relaunch must never produce it.
  const FRESH_REPRO_TEST = `${TEST_AT_HEAD}it('REPRO (fresh session)', () => {});\n`;

  const inMemorySprintRepo = (initial: Sprint): SprintRepository => {
    let current = initial;
    return {
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
    } as unknown as SprintRepository;
  };

  const inMemoryExecutionRepo = (initial: SprintExecution): SprintExecutionRepository => {
    let current = initial;
    return {
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
    };
  };

  const inMemoryTaskRepo = (initial: readonly Task[]): { repo: TaskRepository; tasks: () => readonly Task[] } => {
    let store: Task[] = [...initial];
    const repo = {
      async findBySprintId() {
        return Result.ok(store as readonly Task[]);
      },
      async findById(_sprintId: SprintId, taskId: TaskId) {
        const found = store.find((t) => t.id === taskId);
        if (found === undefined) return Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
        return Result.ok(found);
      },
      async update(_sprintId: SprintId, task: Task) {
        const idx = store.findIndex((t) => t.id === task.id);
        if (idx >= 0) store[idx] = task;
        else store = [...store, task];
        return Result.ok(undefined);
      },
      async saveAll(_sprintId: SprintId, tasks: readonly Task[]) {
        store = [...tasks];
        return Result.ok(undefined);
      },
    } as unknown as TaskRepository;
    return { repo, tasks: () => store };
  };

  const floorPasses = [
    { dimension: 'correctness', passed: true, finding: 'the reproduction passes' },
    { dimension: 'completeness', passed: true, finding: 'steps shipped' },
    { dimension: 'safety', passed: true, finding: 'inputs validated' },
    { dimension: 'consistency', passed: true, finding: 'matches siblings' },
    { dimension: 'robustness', passed: true, finding: 'error paths handled' },
  ];

  const ROLE_MARKERS: Readonly<Record<string, string>> = {
    reproduce: 'reproducing a reported defect before anyone attempts to fix it',
    implement: '# Task Execution Protocol',
    evaluate: 'independent code reviewer',
  };

  interface RecordingProvider extends HeadlessAiProvider {
    readonly spawned: string[];
  }

  /**
   * Dispatches on the prompt's template marker and does what the real session would do to the
   * tree: `reproduce` writes a fresh failing test, `implement` finishes the fix.
   */
  const relaunchProvider = (): RecordingProvider => {
    const spawned: string[] = [];
    return {
      spawned,
      async generate(session: AiSession): Promise<Result<ProviderOutput, DomainError>> {
        const prompt = String(session.prompt);
        const role = Object.entries(ROLE_MARKERS).find(([, marker]) => prompt.includes(marker))?.[0] ?? 'unknown';
        spawned.push(role);
        const cwd = String(session.cwd);
        let signals: readonly HarnessSignal[] = [];
        if (role === 'reproduce') {
          await fs.writeFile(join(cwd, TEST_PATH), FRESH_REPRO_TEST, 'utf8');
          signals = [
            {
              type: 'reproduction',
              testPath: TEST_PATH,
              runCommand: RUN_COMMAND,
              observedFailure: 'fresh failure',
              relevantTests: [],
              timestamp: FIXED_NOW,
            },
          ];
        } else if (role === 'implement') {
          await fs.appendFile(join(cwd, SOURCE_PATH), '// FULL\n', 'utf8');
          signals = [{ type: 'task-verified', output: 'reproduction passes', timestamp: FIXED_NOW }];
        } else if (role === 'evaluate') {
          signals = [{ type: 'evaluation', status: 'passed', dimensions: floorPasses, timestamp: FIXED_NOW }];
        }
        const wrote = await writeJsonAtomic(String(session.signalsFile), { schemaVersion: 1, signals });
        if (!wrote.ok) return Result.error(wrote.error);
        return Result.ok({ signalsFile: session.signalsFile, exitCode: 0 });
      },
    };
  };

  /**
   * The repo's verify script, played by the shell runner: it fails exactly when the reproduction
   * case is in the tree but the fix is not. `redHead` makes it fail unconditionally instead.
   */
  const verifyShell = (opts: { readonly redHead?: boolean } = {}): ShellScriptRunner & { scripts: string[] } => {
    const scripts: string[] = [];
    return {
      scripts,
      async run(cwd: AbsolutePath, script: string) {
        scripts.push(script);
        const read = (rel: string): Promise<string> => fs.readFile(join(String(cwd), rel), 'utf8').catch(() => '');
        const reproPresent = (await read(TEST_PATH)).includes('REPRO');
        const fixed = (await read(SOURCE_PATH)).includes('FULL');
        const passed = opts.redHead !== true && (!reproPresent || fixed);
        const result = { passed, exitCode: passed ? 0 : 1, output: passed ? 'ok' : 'FAIL', durationMs: 0 };
        return Result.ok(result) as Result<typeof result, StorageError>;
      },
    };
  };

  const unusedInteractive: InteractivePrompt = {
    async askText() {
      throw new Error('askText not expected');
    },
    async askTextArea() {
      throw new Error('askTextArea not expected');
    },
    async askChoice() {
      throw new Error('askChoice not expected — the tree is clean and the branch is pre-set');
    },
    async askMultiChoice() {
      throw new Error('askMultiChoice not expected');
    },
    async askConfirm() {
      throw new Error('askConfirm not expected');
    },
  };

  interface Relaunch {
    readonly repo: FakeProject;
    readonly stateDir: string;
    readonly sprint: Sprint;
    readonly execution: SprintExecution;
    readonly task: Task;
    readonly message: string;
  }

  describe('bugfix relaunch after an unblock — real git', () => {
    let cleanupFns: Array<() => Promise<void>>;

    beforeEach(() => {
      cleanupFns = [];
      // Deterministic non-interactive red-baseline handling, even when the suite runs from a TTY.
      vi.stubEnv('RALPHCTL_NO_TUI', '1');
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      for (const fn of cleanupFns) await fn().catch(() => undefined);
    });

    /**
     * The state an unblocked defect-shaped task is relaunched from: its earlier work (reproduction
     * test plus partial fix) quarantined under the task's stash message, and the validated
     * reproduction saved under the task workspace. Written as raw JSON so the fixture pins the
     * on-disk shape rather than whatever the save helper happens to produce.
     */
    const seedRelaunch = async (): Promise<Relaunch> => {
      const repo = await createFakeProject({
        seed: { '.gitignore': 'node_modules/\n', [SOURCE_PATH]: SOURCE_AT_HEAD, [TEST_PATH]: TEST_AT_HEAD },
      });
      await repo.git('checkout', '-q', '-b', SPRINT_BRANCH);
      const stateDir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-bugfix-relaunch-')));
      cleanupFns.push(() => repo.cleanup());
      cleanupFns.push(() => fs.rm(stateDir, { recursive: true, force: true }));
      await fs.mkdir(join(stateDir, 'sprint'), { recursive: true });
      await fs.mkdir(join(stateDir, 'locks'), { recursive: true });

      const ticket = makeApprovedTicket({ title: 'crash-ticket' });
      const sprint = makePlannedSprint({ tickets: [ticket] });
      const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), SPRINT_BRANCH);
      const task = makeTodoTask({
        name: 'fix the null pointer crash',
        order: 1,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
      });
      const message = quarantineStashMessage(sprint.id, task.id);

      await repo.writeFile(TEST_PATH, REPRO_TEST);
      await repo.writeFile(SOURCE_PATH, PARTIAL_SOURCE);
      await repo.git('stash', 'push', '-u', '-m', message);

      const reproduceDir = join(stateDir, 'sprint', 'implement', String(task.id), 'reproduce');
      await fs.mkdir(reproduceDir, { recursive: true });
      await fs.writeFile(
        join(reproduceDir, 'artifact.json'),
        JSON.stringify({
          schemaVersion: 1,
          testPath: TEST_PATH,
          runCommand: RUN_COMMAND,
          observedFailure: SAVED_FAILURE,
          relevantTests: [],
          checksum: createHash('sha256').update(REPRO_TEST, 'utf-8').digest('hex'),
        }),
        'utf8'
      );
      return { repo, stateDir, sprint, execution, task, message };
    };

    const buildDeps = (
      seeded: Relaunch,
      taskRepo: TaskRepository,
      provider: HeadlessAiProvider,
      shellScriptRunner: ShellScriptRunner
    ): ImplementDeps => ({
      sprintRepo: inMemorySprintRepo(seeded.sprint),
      sprintExecutionRepo: inMemoryExecutionRepo(seeded.execution),
      taskRepo,
      generatorProvider: provider,
      evaluatorProvider: provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      publishSignal: () => {},
      eventBus: createInMemoryEventBus(),
      logger: noopLogger,
      clock: () => FIXED_LATER,
      config: {
        harness: {
          maxTurns: 3,
          maxAttempts: 1,
          rateLimitRetries: 0,
          plateauThreshold: 2,
          correctiveRetries: 2,
          escalateOnPlateau: false,
          escalationMap: {},
          skipPreVerifyOnFreshSetup: false,
        },
      },
      gitRunner: createGitRunner(),
      shellScriptRunner,
      fileLocker: createFileLocker(),
      locksRoot: absolutePath(join(seeded.stateDir, 'locks')),
      skillsAdapter: noopSkillsAdapter,
      skillSource: emptySkillSource,
      generatorAgentDefinitionAdapter: noopAgentDefinitionAdapter,
      evaluatorAgentDefinitionAdapter: noopAgentDefinitionAdapter,
      interactive: unusedInteractive,
      writeFile: createAtomicWriteFile(),
      appendFile: createAppendFile(),
      journalMutex: createFoldQueue(),
      ledgerMutex: createFoldQueue(),
    });

    const flowOpts = (seeded: Relaunch) => {
      const sprintDir = join(seeded.stateDir, 'sprint');
      const repoConfig: RepoExecConfig = {
        path: absolutePath(seeded.repo.path),
        name: 'crash-repo',
        verifyScript: VERIFY_SCRIPT,
      };
      return {
        sprintId: seeded.sprint.id,
        todoTasks: [seeded.task],
        repositories: new Map([[FIXED_REPOSITORY_ID, repoConfig]]),
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(join(sprintDir, 'progress.md')),
        sprintDir: absolutePath(sprintDir),
        memoryRoot: absolutePath(join(seeded.stateDir, 'memory')),
        projectId: 'proj-bugfix-relaunch',
        projectSlug: slug('proj-bugfix-relaunch'),
      };
    };

    const stashSubjects = async (repo: FakeProject): Promise<string[]> =>
      (await repo.git('stash', 'list', '--format=%s')).split('\n').filter((line) => line.length > 0);

    const roundPrompt = (seeded: Relaunch, role: 'generator' | 'evaluator'): Promise<string> =>
      fs.readFile(
        join(seeded.stateDir, 'sprint', 'implement', String(seeded.task.id), 'rounds', '1', role, 'prompt.md'),
        'utf8'
      );

    it('continues from the quarantined work: reuses the saved reproduction, measures HEAD, then restores and finishes the fix', async () => {
      const seeded = await seedRelaunch();
      const { repo, task, message } = seeded;
      const taskStore = inMemoryTaskRepo([task]);
      const provider = relaunchProvider();
      const shell = verifyShell();

      const runner = createRunner<ImplementCtx>({
        id: 'r-bugfix-relaunch',
        element: createImplementFlow(buildDeps(seeded, taskStore.repo, provider, shell), flowOpts(seeded)),
        initialCtx: { sprintId: seeded.sprint.id },
      });
      await runner.start();

      expect(runner.status).toBe('completed');
      const settled = taskStore.tasks().find((t) => t.id === task.id);
      expect(settled?.status).toBe('done');
      // Measured on HEAD (green), then on HEAD + the restored work + the new turn (green).
      expect(settled?.attempts.at(-1)?.verifyRuns?.map((r) => [r.phase, r.outcome])).toStrictEqual([
        ['pre', 'success'],
        ['post', 'success'],
      ]);

      // No reproduce session, and the saved command was never re-run: every shell call is the gate.
      expect(provider.spawned).not.toContain('reproduce');
      expect(shell.scripts.length).toBeGreaterThan(0);
      expect(shell.scripts.every((script) => script === VERIFY_SCRIPT)).toBe(true);

      // reproduce → start-attempt → pre-task-verify → restore, with the restore running exactly once.
      const id = String(task.id);
      const indexOf = (name: string): number => runner.trace.findIndex((e) => e.elementName === name);
      const restores = runner.trace.filter((e) => e.elementName === `restore-blocked-diff-${id}`);
      expect(restores.map((e) => e.status)).toStrictEqual(['completed']);
      expect(runner.trace[indexOf(`reproduce-${id}`)]?.status).toBe('completed');
      expect(indexOf(`reproduce-${id}`)).toBeLessThan(indexOf(`start-attempt-${id}`));
      expect(indexOf(`start-attempt-${id}`)).toBeLessThan(indexOf(`pre-task-verify-${id}`));
      expect(indexOf(`pre-task-verify-${id}`)).toBeLessThan(indexOf(`restore-blocked-diff-${id}`));

      // The earlier work came back and the commit holds it plus this launch's turn.
      expect((await stashSubjects(repo)).filter((s) => s.endsWith(`: ${message}`))).toHaveLength(0);
      const committedSource = await repo.git('show', `HEAD:${SOURCE_PATH}`);
      expect(committedSource).toContain('PARTIAL');
      expect(committedSource).toContain('FULL');
      expect(await repo.git('show', `HEAD:${TEST_PATH}`)).toBe(REPRO_TEST);
      expect(await repo.git('status', '--porcelain')).toBe('');

      // Both roles saw the reused reproduction, and the evaluator did not read the restored test
      // as tampered with.
      const generatorPrompt = await roundPrompt(seeded, 'generator');
      expect(generatorPrompt).toContain('<reproduction>');
      expect(generatorPrompt).toContain(TEST_PATH);
      expect(generatorPrompt).toContain(SAVED_FAILURE);
      const evaluatorPrompt = await roundPrompt(seeded, 'evaluator');
      expect(evaluatorPrompt).toContain('<reproduction>');
      expect(evaluatorPrompt).not.toContain(REPRODUCTION_TAMPER_NOTE);
    }, 120_000);

    it('a red HEAD on the relaunch blocks before any turn and leaves the quarantined work in its stash, once', async () => {
      const seeded = await seedRelaunch();
      const { repo, task, message } = seeded;
      const headBefore = await repo.git('rev-parse', 'HEAD');
      const taskStore = inMemoryTaskRepo([task]);
      const provider = relaunchProvider();

      const runner = createRunner<ImplementCtx>({
        id: 'r-bugfix-relaunch-red-head',
        element: createImplementFlow(
          buildDeps(seeded, taskStore.repo, provider, verifyShell({ redHead: true })),
          flowOpts(seeded)
        ),
        initialCtx: { sprintId: seeded.sprint.id },
      });
      await runner.start();

      expect(runner.status).toBe('completed');
      const settled = taskStore.tasks().find((t) => t.id === task.id);
      expect(settled?.status).toBe('blocked');
      expect((settled as BlockedTask).blockedReason).toContain('baseline already red');
      expect(provider.spawned).toStrictEqual([]);

      const restores = runner.trace.filter((e) => e.elementName === `restore-blocked-diff-${String(task.id)}`);
      expect(restores.map((e) => e.status)).toStrictEqual(['skipped']);
      expect(await repo.git('status', '--porcelain')).toBe('');
      expect((await stashSubjects(repo)).filter((s) => s.endsWith(`: ${message}`))).toHaveLength(1);
      expect(await repo.git('rev-parse', 'HEAD')).toBe(headBefore);
      expect(await repo.readFile(SOURCE_PATH)).toBe(SOURCE_AT_HEAD);
    }, 120_000);

    it('the parallel path does the same inside the task worktree and folds the finished fix onto the sprint branch', async () => {
      const seeded = await seedRelaunch();
      const { repo, sprint, execution, task, message } = seeded;
      const taskStore = inMemoryTaskRepo([task]);
      const provider = relaunchProvider();
      const deps = buildDeps(seeded, taskStore.repo, provider, verifyShell());
      const opts = { ...flowOpts(seeded), dirtyTreePolicy: 'cancel' as const };
      const readConfig = () =>
        Promise.resolve({ maxTurns: 3, escalateOnPlateau: false, escalationMap: {}, maxAttempts: 1 });
      const branchDeps = { implement: deps, eventBus: createInMemoryEventBus(), foldQueue: createFoldQueue() };
      const branch = buildWaveBranches(branchDeps, opts, [[task]], readConfig)[0]![0]!;

      const runner = createRunner<ImplementCtx>({
        id: `r-${branch.id}`,
        element: branch.element,
        initialCtx: { sprintId: sprint.id, sprint, execution, tasks: [task] },
      });
      await runner.start();

      expect(runner.status).toBe('completed');
      expect(taskStore.tasks().find((t) => t.id === task.id)?.status).toBe('done');
      expect(provider.spawned).not.toContain('reproduce');
      expect((await stashSubjects(repo)).filter((s) => s.endsWith(`: ${message}`))).toHaveLength(0);
      const foldedSource = await repo.git('show', `${SPRINT_BRANCH}:${SOURCE_PATH}`);
      expect(foldedSource).toContain('PARTIAL');
      expect(foldedSource).toContain('FULL');
      expect(await repo.git('show', `${SPRINT_BRANCH}:${TEST_PATH}`)).toBe(REPRO_TEST);
      const evaluatorPrompt = await roundPrompt(seeded, 'evaluator');
      expect(evaluatorPrompt).toContain('<reproduction>');
      expect(evaluatorPrompt).not.toContain(REPRODUCTION_TAMPER_NOTE);
    }, 120_000);
  });
}
