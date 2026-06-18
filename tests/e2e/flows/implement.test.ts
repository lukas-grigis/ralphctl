import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { TokenUsageEvent } from '@src/business/observability/events.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import {
  absolutePath,
  FIXED_LATER,
  FIXED_NOW,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
  repositoryId,
} from '@tests/fixtures/domain.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createImplementFlow } from '@src/application/flows/implement/flow.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';

const FAKE_CWD = absolutePath('/tmp/ralph/fake-cwd');
const FAKE_REPOSITORIES = new Map([[FIXED_REPOSITORY_ID, { path: FAKE_CWD, name: 'fake-repo' }]]);
// The learnings-ledger opts every `createImplementFlow` call threads through. The append
// leaf only writes when a `<learning>` signal lands. Use a per-file-run unique root (the real
// AppendFile adapter writes the ledger here) so concurrent vitest workers / repeated execs never
// collide on a shared `/tmp` path; torn down in afterAll.
const FAKE_MEMORY_ROOT = absolutePath(mkdtempSync(join(tmpdir(), 'ralphctl-implement-e2e-memory-')));
const FAKE_PROJECT_ID = 'proj-implement-e2e';
afterAll(() => rmSync(String(FAKE_MEMORY_ROOT), { recursive: true, force: true }));

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
  const repo: SprintExecutionRepository = {
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
  return { repo, current: () => current };
};

interface InMemoryTaskRepoState {
  readonly repo: TaskRepository;
  readonly tasks: () => readonly Task[];
  readonly updates: ReadonlyArray<{ readonly task: Task }>;
  readonly saveAlls: ReadonlyArray<readonly Task[]>;
}

const inMemoryTaskRepo = (initial: readonly Task[]): InMemoryTaskRepoState => {
  let store: Task[] = [...initial];
  const updates: Array<{ readonly task: Task }> = [];
  const saveAlls: Array<readonly Task[]> = [];
  const repo: TaskRepository = {
    async findBySprintId(_id) {
      void _id;
      const page: readonly Task[] = store;
      return Result.ok(page);
    },
    async findById(_sprintId, taskId) {
      const t = store.find((tt) => tt.id === taskId);
      if (t === undefined) return Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
      return Result.ok(t);
    },
    async update(_sprintId, task) {
      const idx = store.findIndex((t) => t.id === task.id);
      if (idx >= 0) store[idx] = task;
      else store = [...store, task];
      updates.push({ task });
      return Result.ok(undefined);
    },
    async saveAll(_sprintId, tasks) {
      store = [...tasks];
      saveAlls.push(tasks);
      return Result.ok(undefined);
    },
  };
  return {
    repo,
    tasks: () => store,
    get updates() {
      return updates;
    },
    get saveAlls() {
      return saveAlls;
    },
  };
};

const okGit = (stdout = '', exitCode = 0): Result<GitRunResult, StorageError> =>
  Result.ok({ stdout, stderr: '', exitCode });

/**
 * Tracks a synthetic `HEAD` so resolve-branch + branch-preflight see a coherent working tree.
 * Returns a fresh state per call site so test cases don't bleed state.
 */
const makeCleanGit = (): GitRunner => {
  let head = 'main';
  return {
    async run(_, args) {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return okGit(`${head}\n`);
      if (args[0] === 'show-ref') return okGit('', 1); // branch absent — exercises the create path
      if (args[0] === 'checkout') {
        const target = args[1] === '-b' ? args[2] : args[1];
        if (target !== undefined) head = target;
        return okGit();
      }
      return okGit('');
    },
  };
};

const cleanGit: GitRunner = makeCleanGit();

interface CommitCapturingGit {
  readonly runner: GitRunner;
  readonly commitMessages: () => readonly string[];
}

/**
 * Fake git runner for e2e tests that need to observe the per-task commit message.
 *
 * Models the worktree as having pending changes BEFORE a commit and being clean AFTER the
 * commit runs. The settle-attempt leaf's worktree-clean guardrail relies on this — running
 * `status --porcelain` post-commit must return clean, otherwise settle (correctly) refuses
 * to mark the task done. Sequence for one task:
 *
 *   working-tree-clean-check `status` → clean (pre-setup hard gate)
 *   preflight-task `status`           → clean (interactive dirty-tree gate; clean → no prompt)
 *   commit-task `status` (gate 1) → dirty   (the AI just wrote files)
 *   commit-task `add -A`
 *   commit-task `status` (gate 2) → dirty   (staged but not committed yet)
 *   commit-task `commit -m <msg>` → captures the message
 *   commit-task `rev-parse HEAD`  → returns a synthetic SHA
 *   settle-attempt `status`       → clean   (commit consumed the diff)
 */
const commitCapturingGit = (taskCount: number): CommitCapturingGit => {
  const messages: string[] = [];
  let taskCommits = 0;
  // Worktree starts clean — the chain's pre-setup hard gate (working-tree-clean-check) +
  // post-setup interactive gate (preflight-task) both expect a clean tree at sprint start.
  // After those upfront preflight calls we're "in a per-task window": status returns dirty
  // until commit-task's `commit -m` lands, then clean again (settle-attempt's worktree-clean
  // guardrail relies on the clean response). The next task re-enters the dirty window when
  // its status calls start.
  let preflightStatusesRemaining = 2;
  let cleanAfterCommit = false;
  const sha = (i: number): string =>
    String(i)
      .padStart(40, '0')
      .replace(/[^0-9a-f]/gi, '0');

  let head = 'main';

  const runner: GitRunner = {
    async run(_, args) {
      if (args[0] === 'status' && args[1] === '--porcelain') {
        if (preflightStatusesRemaining > 0) {
          preflightStatusesRemaining -= 1;
          return okGit('', 0); // upfront preflight (working-tree-clean-check + preflight-task): clean
        }
        // After a successful commit the tree is clean (settle guardrail check). The next
        // task's first status starts a new dirty window automatically because we flip the
        // flag back off here.
        if (cleanAfterCommit) {
          cleanAfterCommit = false;
          return okGit('', 0);
        }
        return okGit(' M file\n', 0); // commit-task gate: dirty
      }
      if (args[0] === 'add' && args[1] === '-A') return okGit('', 0);
      // Serial-path quarantine of a blocked task's rejected diff: `gitStashPush` runs `status
      // --porcelain` (handled above — dirty for the just-blocked task) then `stash push -u -m …`.
      // Report success so the quarantine leaf records its pointer and the run proceeds.
      if (args[0] === 'stash' && args[1] === 'push') return okGit('Saved working directory\n', 0);
      // restore-blocked-diff runs `stash list --format=%s` at the START of each attempt. No prior
      // task was quarantined-then-retried in these tests → empty list → the leaf is a clean no-op.
      if (args[0] === 'stash' && args[1] === 'list') return okGit('', 0);
      if (args[0] === 'commit' && args[1] === '-m') {
        messages.push(args[2] ?? '');
        cleanAfterCommit = true;
        return okGit('', 0);
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        taskCommits += 1;
        const commitSha = sha(taskCommits);
        return okGit(`${commitSha}\n`, 0);
      }
      // Branch-resolution path: resolve-branch + per-task branch-preflight.
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return okGit(`${head}\n`, 0);
      if (args[0] === 'show-ref') return okGit('', 1); // absent — exercises the create path
      if (args[0] === 'checkout') {
        const target = args[1] === '-b' ? args[2] : args[1];
        if (target !== undefined) head = target;
        return okGit('', 0);
      }
      // The evaluator leaf fingerprints the working tree each round (status --porcelain handled
      // above + diff HEAD + ls-files here) for the plateau predicate. A fixed diff body and an
      // empty untracked list are fine — these tests pass on the first turn, so the fingerprint
      // is never compared against a prior round.
      if (args[0] === 'diff' && args[1] === 'HEAD') return okGit('@@ -1 +1 @@\n-old\n+new\n', 0);
      if (args[0] === 'ls-files') return okGit('', 0); // no untracked files → hash-object never runs
      void taskCount;
      throw new Error(`unscripted git args: ${args.join(' ')}`);
    },
  };
  return { runner, commitMessages: () => messages };
};

const passingShell: ShellScriptRunner = {
  async run() {
    return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
  },
};

interface FixtureBundle {
  readonly sprint: Sprint;
  readonly execution: SprintExecution;
  readonly tasks: readonly Task[];
  readonly progressFile: string;
  readonly dir: string;
  cleanup(): Promise<void>;
}

const buildFixture = async (taskCount = 1, taskMaxAttempts?: number): Promise<FixtureBundle> => {
  const ticket = makeApprovedTicket({ title: 'a-ticket' });
  const sprint = makePlannedSprint({ tickets: [ticket] });
  // Pre-set the sprint branch so resolveBranchLeaf takes the resume path instead of prompting
  // the user for a branch strategy. The first-run prompt is exercised by its own unit test.
  const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'ralphctl/test');
  const tasks = Array.from({ length: taskCount }, (_, i) =>
    makeTodoTask({
      name: `task-${String(i + 1)}`,
      order: i + 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
      ...(taskMaxAttempts !== undefined ? { maxAttempts: taskMaxAttempts } : {}),
    })
  );
  const dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-impl-')));
  const progressFile = join(dir, 'progress.md');
  return {
    sprint,
    execution,
    tasks,
    progressFile,
    dir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
};

const buildDeps = (
  sprintRepo: SprintRepository,
  executionRepo: SprintExecutionRepository,
  taskRepo: TaskRepository,
  provider: ImplementDeps['generatorProvider'],
  locksRoot: string,
  gitRunner: GitRunner = cleanGit
): ImplementDeps => ({
  sprintRepo,
  sprintExecutionRepo: executionRepo,
  taskRepo,
  // Both roles share the same provider fake — the legacy single-provider tests assert
  // gen-eval behaviour without exercising the cross-provider split.
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
      maxAttempts: 3,
      rateLimitRetries: 0,
      plateauThreshold: 2,
      escalateOnPlateau: false,
      escalationMap: {},
      skipPreVerifyOnFreshSetup: false,
    },
  },
  gitRunner,
  shellScriptRunner: passingShell,
  fileLocker: createFileLocker(),
  locksRoot: absolutePath(locksRoot),
  skillsAdapter: noopSkillsAdapter,
  skillSource: emptySkillSource,
  interactive: unusedInteractive,
  writeFile: createAtomicWriteFile(),
  appendFile: createAppendFile(),
});

const unusedInteractive: InteractivePrompt = {
  async askText() {
    throw new Error('implement-test: askText not expected — resume path skips the prompt');
  },
  async askTextArea() {
    throw new Error('implement-test: askTextArea not expected');
  },
  async askChoice() {
    throw new Error('implement-test: askChoice not expected — resume path skips the prompt');
  },
  async askMultiChoice() {
    throw new Error('implement-test: askMultiChoice not expected');
  },
  async askConfirm() {
    throw new Error('implement-test: askConfirm not expected');
  },
};

// ─── Signal builders ────────────────────────────────────────────────────────────────
// Production AI providers write `signals.json` directly under the audit-[09] contract;
// fakes mirror that by feeding explicit `HarnessSignal[]` arrays to the fake provider.
// The builders below cover the shapes used across this suite — `taskVerified('ok')`
// reads better at the call site than the literal object.

const taskVerified = (output: string): HarnessSignal => ({ type: 'task-verified', output, timestamp: FIXED_NOW });

const taskBlocked = (reason: string): HarnessSignal => ({ type: 'task-blocked', reason, timestamp: FIXED_NOW });

const learning = (text: string): HarnessSignal => ({ type: 'learning', text, timestamp: FIXED_NOW });

const note = (text: string): HarnessSignal => ({ type: 'note', text, timestamp: FIXED_NOW });

const commitMessage = (subject: string, body?: string): HarnessSignal => ({
  type: 'commit-message',
  subject,
  ...(body !== undefined ? { body } : {}),
  timestamp: FIXED_NOW,
});

/**
 * The three floor dimensions other than `correctness`, all passing — appended so terminal
 * verdicts carry the full floor set the signal schema now requires.
 */
const floorPasses = [
  { dimension: 'completeness', passed: true, finding: 'steps shipped' },
  { dimension: 'safety', passed: true, finding: 'inputs validated' },
  { dimension: 'consistency', passed: true, finding: 'matches siblings' },
];

/**
 * Synthesise a FAIL verdict — the correctness floor dimension fails, the rest pass. Carries the
 * full floor set the schema now requires while preserving the "generic failure" intent of the
 * older single-`overall` fixtures.
 */
const evaluationFailed = (critique: string): EvaluationSignal => ({
  type: 'evaluation',
  status: 'failed',
  dimensions: [
    { dimension: 'correctness', passed: false, finding: critique.length > 0 ? critique : 'failed' },
    ...floorPasses,
  ],
  critique,
  timestamp: FIXED_NOW,
});

const evaluationPassed = (): EvaluationSignal => ({
  type: 'evaluation',
  status: 'passed',
  dimensions: [{ dimension: 'correctness', passed: true, finding: 'all good' }, ...floorPasses],
  timestamp: FIXED_NOW,
});

describe('createImplementFlow — gen-eval loop', () => {
  let cleanupFns: Array<() => Promise<void>>;
  beforeEach(() => {
    cleanupFns = [];
  });
  afterEach(async () => {
    for (const fn of cleanupFns) await fn();
  });

  const tracking = (b: FixtureBundle): void => {
    cleanupFns.push(b.cleanup);
  };

  it('writes rounds/<n>/outcome.md after the attempt settles, with the synthesis paragraph', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('tests pass')],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-outcome-md',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();
    expect(runner.status).toBe('completed');

    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    const outcomePath = join(f.dir, 'implement', String(task.id), 'rounds', '1', 'outcome.md');
    const outcome = await fs.readFile(outcomePath, 'utf8');
    expect(outcome).toContain('# Round 1 · attempt 1');
    expect(outcome).toContain('- verdict: passed');
    expect(outcome).toContain('## Synthesis');
    expect(outcome).toMatch(/Round 1 of attempt 1 passed all evaluator dimensions/);
    expect(outcome).not.toContain('## Critique');
  });

  it('first-try pass: implement verifies, evaluator passes — task → done, sprint → review in one turn', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('tests pass')],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-pass',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('done');
    if (finalTask?.status === 'done') {
      expect(finalTask.attempts).toHaveLength(1);
      expect(finalTask.attempts[0]?.status).toBe('verified');
    }
    // saveAll fired at end of chain.
    expect(taskRepo.saveAlls).toHaveLength(1);
    expect(taskRepo.saveAlls[0]?.[0]?.status).toBe('done');
    // Sprint transitioned to review.
    expect(sprintRepo.current().status).toBe('review');
  });

  it('cross-provider gen-eval: generator and evaluator deps route to distinct provider instances per role', async () => {
    // AC3 of the per-role implement wiring: passing distinct providers as `generatorProvider`
    // and `evaluatorProvider` must route the gen leaf's spawn to the generator-provider and
    // the eval leaf's spawn to the evaluator-provider, with no cross-talk. The two fakes only
    // script their own role's signals — a route mistake would surface as a `no-marker-match`
    // failure from the wrong-role fake (the leaf's prompt would carry the other role's marker).
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const generatorFake = createFakeAiProvider({
      signals: { implement: [taskVerified('tests pass')] },
    });
    const evaluatorFake = createFakeAiProvider({
      signals: { evaluate: [evaluationPassed()] },
    });

    const baseDeps = buildDeps(
      sprintRepo.repo,
      inMemoryExecutionRepo(f.execution).repo,
      taskRepo.repo,
      generatorFake,
      f.dir
    );
    const deps: ImplementDeps = { ...baseDeps, generatorProvider: generatorFake, evaluatorProvider: evaluatorFake };

    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'openai-codex',
      evaluatorModel: 'gpt-5.5',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });
    const runner = createRunner({
      id: 'r-impl-per-role',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Each provider was called exactly once — one generator turn, one evaluator turn.
    expect(generatorFake.recordedSessions).toHaveLength(1);
    expect(evaluatorFake.recordedSessions).toHaveLength(1);
    // The generator's signalsFile lives under .../generator/signals.json; the evaluator's
    // under .../evaluator/signals.json. Cross-talk would route a spawn into the wrong role
    // folder, which the leaf-side `validateSignalsFile` would then reject.
    expect(String(generatorFake.recordedSessions[0]?.signalsFile)).toContain('/generator/signals.json');
    expect(String(evaluatorFake.recordedSessions[0]?.signalsFile)).toContain('/evaluator/signals.json');
    // Per-role model is threaded into each provider's session — confirms the launcher's
    // generatorModel / evaluatorModel split flows down to the leaf's AiSession.
    expect(generatorFake.recordedSessions[0]?.model).toBe('claude-opus-4-8');
    expect(evaluatorFake.recordedSessions[0]?.model).toBe('gpt-5.5');
  });

  it('per-round implement run publishes one role-tagged TokenUsageEvent for each of generator and evaluator', async () => {
    // C4: subscribers should be able to attribute token spend to one half of the implement
    // pair without inferring from `provider` alone. The production adapters stamp `role` on
    // every `TokenUsageEvent` they publish; we mirror that contract here with a thin wrapper
    // over the fake provider so the bus-subscriber assertion runs end-to-end through a real
    // chain run without touching the real CLIs.
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const generatorFake = createFakeAiProvider({
      signals: { implement: [taskVerified('tests pass')] },
    });
    const evaluatorFake = createFakeAiProvider({
      signals: { evaluate: [evaluationPassed()] },
    });

    const eventBus: EventBus = createInMemoryEventBus();
    const tokenEvents: TokenUsageEvent[] = [];
    eventBus.subscribe((e) => {
      if (e.type === 'token-usage') tokenEvents.push(e);
    });

    const tokenEmittingWrapper = (
      inner: HeadlessAiProvider,
      provider: TokenUsageEvent['provider']
    ): HeadlessAiProvider => ({
      async generate(session) {
        const out = await inner.generate(session);
        if (out.ok) {
          eventBus.publish({
            type: 'token-usage',
            sessionId: out.value.sessionId ?? `${provider}-sess`,
            provider,
            model: session.model,
            ...(session.role !== undefined ? { role: session.role } : {}),
            at: IsoTimestamp.now(),
          });
        }
        return out;
      },
    });

    const baseDeps = buildDeps(
      sprintRepo.repo,
      inMemoryExecutionRepo(f.execution).repo,
      taskRepo.repo,
      generatorFake,
      f.dir
    );
    const deps: ImplementDeps = {
      ...baseDeps,
      eventBus,
      generatorProvider: tokenEmittingWrapper(generatorFake, 'claude-code'),
      evaluatorProvider: tokenEmittingWrapper(evaluatorFake, 'openai-codex'),
    };

    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'openai-codex',
      evaluatorModel: 'gpt-5.5',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });
    const runner = createRunner({
      id: 'r-impl-token-roles',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    const generatorEvents = tokenEvents.filter((e) => e.role === 'generator');
    const evaluatorEvents = tokenEvents.filter((e) => e.role === 'evaluator');
    expect(generatorEvents.length).toBeGreaterThanOrEqual(1);
    expect(evaluatorEvents.length).toBeGreaterThanOrEqual(1);
    // The role tag flows hand-in-hand with the per-role model the launcher picks — confirms
    // a future regression that drops `role` from the AiSession or the event would surface as
    // both halves of the pair landing on the same role.
    expect(generatorEvents[0]?.model).toBe('claude-opus-4-8');
    expect(evaluatorEvents[0]?.model).toBe('gpt-5.5');
  });

  it('pass-after-retry: turn 1 fails, turn 2 passes — single attempt, two recorded turns', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    let evalCalls = 0;
    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('tests pass')],
        evaluate: () => {
          evalCalls += 1;
          return evalCalls === 1 ? [evaluationFailed('missing edge case')] : [evaluationPassed()];
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-retry-pass',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(evalCalls).toBe(2);
    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('done');
    if (finalTask?.status === 'done') {
      // Single attempt — the retry budget is per turn within one attempt.
      expect(finalTask.attempts).toHaveLength(1);
      expect(finalTask.attempts[0]?.status).toBe('verified');
    }
    expect(sprintRepo.current().status).toBe('review');
  });

  it('exhausted budget: every turn fails — task → done with budget-exhausted warning, sprint → review', async () => {
    const f = await buildFixture(1, 1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    let evalCalls = 0;
    let implementCalls = 0;
    // Critique varies per turn — Jaccard < 0.5 between rounds — so plateau detection's
    // critique-shift exemption keeps the loop running until the maxTurns budget itself fires.
    const critiques = [
      'first round complaint about parser edge case behaviour',
      'second turn — completely different concern about retry semantics',
      'third pass discovered a SQL injection vector in the dynamic query builder',
    ];
    const provider = createFakeAiProvider({
      signals: {
        implement: () => {
          implementCalls += 1;
          return [taskVerified('tests pass')];
        },
        evaluate: () => {
          const text = critiques[evalCalls] ?? 'fallback critique';
          evalCalls += 1;
          return [evaluationFailed(text)];
        },
      },
    });

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      config: {
        harness: {
          maxTurns: 3,
          maxAttempts: 3,
          rateLimitRetries: 0,
          plateauThreshold: 2,
          escalateOnPlateau: false,
          escalationMap: {},
          skipPreVerifyOnFreshSetup: false,
        },
      },
    };
    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });

    const runner = createRunner({
      id: 'r-impl-exhausted',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(implementCalls).toBe(3);
    expect(evalCalls).toBe(3);

    // Budget exhaustion → markTaskDone with attempt warning. Final attempt is `verified` because
    // each turn ran `recordRunningAttemptVerification` before the (rejected) eval.
    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('done');
    if (finalTask?.status === 'done') {
      const attempt = finalTask.attempts.at(-1);
      expect(attempt?.warning?.kind).toBe('budget-exhausted');
    }
    expect(sprintRepo.current().status).toBe('review');
  });

  it('mid-loop block: implement signals <task-blocked> — task → blocked, evaluator never runs, sprint stays active (no done task to review)', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    let evalCalls = 0;
    const provider = createFakeAiProvider({
      signals: {
        implement: [taskBlocked('missing API key')],
        evaluate: () => {
          evalCalls += 1;
          return [evaluationPassed()];
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-mid-block',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(evalCalls).toBe(0);

    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('blocked');
    if (finalTask?.status === 'blocked') {
      expect(finalTask.blockedReason).toBe('missing API key');
    }
    // No task settled `done`, so the chain leaves the sprint in `active` rather than
    // transitioning to `review`. Re-running implement after the blocker is fixed picks the
    // sprint back up without manual state-back-out.
    expect(sprintRepo.current().status).toBe('active');
  });

  it('multi-task: continues to the next task after one settles to blocked; trace order is stable', async () => {
    const f = await buildFixture(2, 1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);
    let implCalls = 0;
    let evalCalls = 0;
    const provider = createFakeAiProvider({
      signals: {
        implement: () => {
          implCalls += 1;
          return implCalls === 1 ? [taskBlocked('cannot find dep')] : [taskVerified('second task complete')];
        },
        evaluate: () => {
          evalCalls += 1;
          return [evaluationPassed()];
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-multi',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    const persisted = taskRepo.tasks();
    expect(persisted[0]?.status).toBe('blocked');
    expect(persisted[1]?.status).toBe('done');
    expect(evalCalls).toBe(1);
    expect(sprintRepo.current().status).toBe('review');

    const elementNames = runner.trace.map((e) => e.elementName);
    const idxLoadSprint = elementNames.indexOf('load-sprint');
    const idxAssert = elementNames.indexOf('assert-sprint-status');
    const idxLoadExec = elementNames.indexOf('load-sprint-execution');
    const idxLoadTasks = elementNames.indexOf('load-tasks');
    const idxResolveBranch = elementNames.indexOf('resolve-branch');
    const idxWorkingTreeClean = elementNames.findIndex((n) => n.startsWith('working-tree-clean-check-'));
    const idxSetupScript = elementNames.indexOf('setup-script-runner');
    const idxSaveTasks = elementNames.indexOf('save-tasks');
    const idxTransition = elementNames.indexOf('transition-sprint-to-review');
    expect(idxLoadSprint).toBeGreaterThanOrEqual(0);
    expect(idxAssert).toBeGreaterThan(idxLoadSprint);
    expect(idxLoadExec).toBeGreaterThan(idxAssert);
    expect(idxLoadTasks).toBeGreaterThan(idxLoadExec);
    // Pre-setup gate: resolve-branch + working-tree-clean-check land BEFORE setup-script-runner
    // so the user sees branch + dirty-tree problems surfaced before a multi-minute setup script
    // runs. The interactive preflight-task gate stays downstream of setup as a recovery seam.
    expect(idxResolveBranch).toBeGreaterThan(idxLoadTasks);
    expect(idxWorkingTreeClean).toBeGreaterThan(idxResolveBranch);
    expect(idxSetupScript).toBeGreaterThan(idxWorkingTreeClean);
    expect(idxSaveTasks).toBeGreaterThan(idxSetupScript);
    expect(idxTransition).toBeGreaterThan(idxSaveTasks);

    // Per-task entries appear in factory order — task-<id1> before task-<id2>.
    const startEntries = elementNames.filter((n) => n.startsWith('start-attempt-'));
    expect(startEntries[0]).toContain(String(f.tasks[0]?.id));
    expect(startEntries[1]).toContain(String(f.tasks[1]?.id));
  });

  it('evaluator signals-contract failure on task 1 blocks task 1 but the run continues to task 2', async () => {
    // Regression: a non-Claude evaluator that fails to produce a usable signals.json (wrong
    // shape, wrong place, non-zero spawn exit) used to abort the WHOLE implement run via the
    // loop's error propagation. It must now self-block ONLY task 1 (settled `blocked`, NOT
    // `done` — the generator's ungraded change is never committed) and let task 2 run.
    const f = await buildFixture(2, 1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    // Generator always succeeds; the evaluator FAILS its signals.json on its first call only.
    const generatorFake = createFakeAiProvider({
      signals: { implement: [taskVerified('work landed')] },
    });
    const baseEvaluator = createFakeAiProvider({
      signals: { evaluate: [evaluationPassed()] },
    });
    let evalCalls = 0;
    // Wrap the evaluator so the FIRST evaluate spawn returns a signals-contract failure
    // (mirrors a codex/copilot reviewer writing a malformed/absent signals.json); later
    // evaluates pass through and write a valid passing verdict.
    const evaluatorFake: HeadlessAiProvider = {
      async generate(session) {
        evalCalls += 1;
        if (evalCalls === 1) {
          return Result.error(
            new InvalidStateError({
              entity: 'codex-provider',
              currentState: 'signals-missing',
              attemptedAction: 'complete evaluation',
              message: 'signals.json not found in outputDir',
            })
          );
        }
        return baseEvaluator.generate(session);
      },
    };

    const baseDeps = buildDeps(
      sprintRepo.repo,
      inMemoryExecutionRepo(f.execution).repo,
      taskRepo.repo,
      generatorFake,
      f.dir
    );
    const deps: ImplementDeps = { ...baseDeps, generatorProvider: generatorFake, evaluatorProvider: evaluatorFake };

    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'openai-codex',
      evaluatorModel: 'gpt-5.5',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });

    const runner = createRunner({
      id: 'r-impl-eval-block',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    // The whole run does NOT abort — it completes.
    expect(runner.status).toBe('completed');
    // Both tasks got an evaluate turn (task 1's failed, task 2's passed).
    expect(evalCalls).toBe(2);

    const persisted = taskRepo.tasks();
    expect(persisted[0]?.status).toBe('blocked');
    if (persisted[0]?.status === 'blocked') {
      // The validator's precise message lands in the block reason for the operator.
      expect(persisted[0].blockedReason).toContain('evaluator did not produce a valid signals.json');
      expect(persisted[0].blockedReason).toContain('signals.json not found in outputDir');
    }
    expect(persisted[1]?.status).toBe('done');
    // A mixed run (one done) still transitions the sprint to review.
    expect(sprintRepo.current().status).toBe('review');
  });

  it('proposed <commit-message> signal: harness commits with subject+body, not the default factory', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);
    const git = commitCapturingGit(1);

    const provider = createFakeAiProvider({
      signals: {
        implement: [
          commitMessage('add user-id index', 'Speeds up the session lookup hot path.'),
          taskVerified('tests pass'),
        ],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir, git.runner),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-commit-message',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(git.commitMessages()).toEqual(['add user-id index\n\nSpeeds up the session lookup hot path.']);
    // Sanity: the default factory's `task(<id>):` prefix never reached the runner.
    expect(git.commitMessages()[0]).not.toContain('task(');
  });

  it('no <commit-message> signal: default factory message lands at the git runner', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);
    const git = commitCapturingGit(1);

    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('tests pass')],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir, git.runner),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const chain = createRunner({
      id: 'r-impl-default-commit-msg',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await chain.start();

    expect(chain.status).toBe('completed');
    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    // Default factory: subject = task name; body = first paragraph of description (none here).
    expect(git.commitMessages()).toEqual([task.name]);
    expect(git.commitMessages()[0]).not.toContain('task(');
  });

  // ─── REQ-4..7: per-task workspace artifacts + signal-driven progress.md ──────────

  it('REQ-4: writes per-round artifacts under <sprintDir>/implement/<task-id>/rounds/<N>/', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    // One generator + one evaluator turn — both should land artifacts under rounds/1/.
    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('gen body'), note('gen-note')],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-round-artifacts',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();
    expect(runner.status).toBe('completed');

    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    const workspace = join(f.dir, 'implement', String(task.id));

    // Per-task derived files (already covered by REQ-1..3, re-asserted here for the e2e shape).
    await expect(fs.access(join(workspace, 'prompt.md'))).resolves.toBeUndefined();
    // Audit [05] deletion: done-criteria.md no longer ships; criteria are inlined into prompt.md.

    // Generator round 1 — provider wrote signals.json directly; session.md is gone.
    const genSignals = JSON.parse(
      await fs.readFile(join(workspace, 'rounds', '1', 'generator', 'signals.json'), 'utf8')
    );
    expect(Array.isArray(genSignals)).toBe(true);
    expect(genSignals.some((s: { type: string }) => s.type === 'task-verified')).toBe(true);
    expect(genSignals.some((s: { type: string }) => s.type === 'note')).toBe(true);
    await expect(fs.access(join(workspace, 'rounds', '1', 'generator', 'session.md'))).rejects.toThrow();

    // Evaluator round 1.
    const evalSignals = JSON.parse(
      await fs.readFile(join(workspace, 'rounds', '1', 'evaluator', 'signals.json'), 'utf8')
    );
    expect(
      evalSignals.some((s: { type: string; status?: string }) => s.type === 'evaluation' && s.status === 'passed')
    ).toBe(true);
    const evaluationMd = await fs.readFile(join(workspace, 'rounds', '1', 'evaluator', 'evaluation.md'), 'utf8');
    // Under the audit-[09] evaluator contract, `evaluation.md` is rendered via
    // `renderEvaluationMarkdown` — the H1 carries the status (`# Evaluation — passed`).
    expect(evaluationMd).toContain('# Evaluation — passed');
    await expect(fs.access(join(workspace, 'rounds', '1', 'evaluator', 'session.md'))).rejects.toThrow();
  });

  it('REQ-4: rounds/<N> increments across turns; empty signal stream serialises to []', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    // Turn 1: implement passes, evaluator fails (forces a second turn).
    // Turn 2: implement emits nothing parseable (empty signal stream), evaluator passes.
    let implCalls = 0;
    let evalCalls = 0;
    const provider = createFakeAiProvider({
      signals: {
        implement: () => {
          implCalls += 1;
          return implCalls === 1 ? [taskVerified('first body')] : [];
        },
        evaluate: () => {
          evalCalls += 1;
          return evalCalls === 1 ? [evaluationFailed('retry')] : [evaluationPassed()];
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-round-increment',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();
    expect(runner.status).toBe('completed');

    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    const workspace = join(f.dir, 'implement', String(task.id));

    // Both rounds materialised.
    expect((await fs.readdir(join(workspace, 'rounds'))).sort()).toEqual(['1', '2']);

    // Round 2's generator emitted no parseable signals → signals.json must be [], not missing.
    const round2GenSignals = await fs.readFile(join(workspace, 'rounds', '2', 'generator', 'signals.json'), 'utf8');
    expect(JSON.parse(round2GenSignals)).toEqual([]);
  });

  it('stamps rounds/<N>/<role>/meta.json with provider/model/effort for each gen-eval turn', async () => {
    // Per-round / per-role AI attribution sidecar (stamp-role-meta leaves). Settings.ai
    // mutates between runs, so persisting the row in `settings.json` alone loses historical
    // attribution — the on-disk meta.json captures who ran each round at the moment of the
    // spawn. Asserts both the generator pass (round-claiming) and the evaluator pass
    // (reading the round seeded by the generator pass).
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('tests pass')],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        // Mixed providers so the asserted strings can't accidentally match the wrong row —
        // generator on Claude, evaluator on Codex. The cross-provider gen-eval split is the
        // load-bearing case this attribution data exists to disambiguate.
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        generatorEffort: 'high',
        evaluatorProviderId: 'openai-codex',
        evaluatorModel: 'gpt-5.5',
        evaluatorEffort: 'medium',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-role-meta',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();
    expect(runner.status).toBe('completed');

    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    const workspace = join(f.dir, 'implement', String(task.id));

    // Generator pass: role-meta.json carries the implement-specific shape (explicit role,
    // attemptN, escalatedFromModel). The sibling meta.json (written by the generic
    // _shared/stamp-session-meta leaf) covers the cross-flow shape and is asserted further
    // down.
    const genRoleMeta = JSON.parse(
      await fs.readFile(join(workspace, 'rounds', '1', 'generator', 'role-meta.json'), 'utf8')
    );
    expect(genRoleMeta).toMatchObject({
      role: 'generator',
      provider: 'claude-code',
      model: 'claude-opus-4-8',
      effort: 'high',
      attemptN: 1,
      roundN: 1,
      escalatedFromModel: null,
    });
    expect(typeof genRoleMeta.startedAt).toBe('string');

    // Generic meta.json sidecar (one stamped per AI spawn across all flows). Encodes role
    // into `flow` (`implement-generator` / `implement-evaluator`) rather than carrying an
    // explicit `role` field — the two sidecars are intentionally complementary, not
    // duplicates.
    const genMeta = JSON.parse(await fs.readFile(join(workspace, 'rounds', '1', 'generator', 'meta.json'), 'utf8'));
    expect(genMeta).toMatchObject({
      flow: 'implement-generator',
      provider: 'claude-code',
      model: 'claude-opus-4-8',
      effort: 'high',
      attemptN: 1,
      roundN: 1,
    });
    expect(typeof genMeta.startedAt).toBe('string');

    // Evaluator pass: different provider/model/effort than the generator, written into the
    // same round directory. Cross-provider attribution is the whole point.
    const evalRoleMeta = JSON.parse(
      await fs.readFile(join(workspace, 'rounds', '1', 'evaluator', 'role-meta.json'), 'utf8')
    );
    expect(evalRoleMeta).toMatchObject({
      role: 'evaluator',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      effort: 'medium',
      attemptN: 1,
      roundN: 1,
      escalatedFromModel: null,
    });
    expect(typeof evalRoleMeta.startedAt).toBe('string');

    const evalMeta = JSON.parse(await fs.readFile(join(workspace, 'rounds', '1', 'evaluator', 'meta.json'), 'utf8'));
    expect(evalMeta).toMatchObject({
      flow: 'implement-evaluator',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      effort: 'medium',
      attemptN: 1,
      roundN: 1,
    });
    expect(typeof evalMeta.startedAt).toBe('string');

    // The stamp leaves are wired in the chain trace BEFORE each spawn — assert the ordering
    // so a refactor that inadvertently moves them after the spawn is caught here.
    // Use exact names (the per-task leaves carry the task id suffix) to avoid `startsWith`
    // false matches between `stamp-role-meta-generator-<id>` and `generator-<id>`.
    const trace = runner.trace.map((e) => e.elementName);
    const expectedStampGen = `stamp-role-meta-generator-${String(task.id)}`;
    const expectedGen = `generator-${String(task.id)}`;
    const expectedStampEval = `stamp-role-meta-evaluator-${String(task.id)}`;
    const expectedEval = `evaluator-${String(task.id)}`;
    const idxStampGen = trace.indexOf(expectedStampGen);
    const idxGen = trace.indexOf(expectedGen);
    const idxStampEval = trace.indexOf(expectedStampEval);
    const idxEval = trace.indexOf(expectedEval);
    expect(idxStampGen).toBeGreaterThanOrEqual(0);
    expect(idxStampEval).toBeGreaterThanOrEqual(0);
    expect(idxGen).toBeGreaterThanOrEqual(0);
    expect(idxEval).toBeGreaterThanOrEqual(0);
    expect(idxStampGen).toBeLessThan(idxGen);
    expect(idxStampEval).toBeLessThan(idxEval);
  });

  it('progress.md grows append-only — one task-attempt section per settled attempt plus a status separator on review', async () => {
    // Audit-[07]: progress.md is the sole writer for the sprint's chronological journal. The
    // implement chain appends one section per settled attempt (via progress-journal-leaf) and
    // a separator line when the sprint transitions to review.
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      signals: {
        implement: [learning('sqlite expects explicit pragmas'), taskVerified('tests pass')],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-progress-md',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();
    expect(runner.status).toBe('completed');

    const md = await fs.readFile(f.progressFile, 'utf8');
    // Append-only journal shape: activation separator, then a task-attempt section, then the
    // review-transition separator. No `## Status`, no `## Tasks` table — the canonical entity
    // state lives in `tasks.json` / `sprint.json`.
    expect(md).not.toContain('## Status');
    expect(md).not.toContain('## Tasks');
    expect(md).toContain('_Sprint activated at');
    expect(md).toMatch(/## Task: .* — Attempt 1/);
    expect(md).toContain('- Verdict: pass');
    expect(md).toContain('_Sprint transitioned to review at');
    // The AI-emitted learning signal lands in the round's signals.json (audit-[09]), not the journal.
    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    const signals = await fs.readFile(
      join(f.dir, 'implement', String(task.id), 'rounds', '1', 'generator', 'signals.json'),
      'utf8'
    );
    expect(JSON.parse(signals).some((s: { type: string }) => s.type === 'learning')).toBe(true);
  });

  it('resume preserves prior round artifacts and grows the journal — prior progress.md content is kept verbatim', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    // Pre-seed a prior run: rounds/1/generator/ + a pre-existing progress.md header. The
    // append-only journal grows from this header — prior content stays verbatim.
    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    const workspace = join(f.dir, 'implement', String(task.id));
    const round1Gen = join(workspace, 'rounds', '1', 'generator');
    await fs.mkdir(round1Gen, { recursive: true });
    await fs.writeFile(join(round1Gen, 'signals.json'), '[{"type":"prior"}]', 'utf8');
    await fs.writeFile(f.progressFile, '# Sprint: kept\n\n- id: kept\n- created: 2026-05-13T00:00:00.000Z\n', 'utf8');

    const provider = createFakeAiProvider({
      signals: {
        implement: [learning('fresh learning'), taskVerified('tests pass')],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const runner = createRunner({
      id: 'r-impl-resume',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();
    expect(runner.status).toBe('completed');

    // Prior round artifacts are untouched — the round folder is the source of truth for prior work.
    expect(await fs.readFile(join(round1Gen, 'signals.json'), 'utf8')).toBe('[{"type":"prior"}]');
    // New round was written at N=2 — provider wrote signals.json there.
    const round2Signals = JSON.parse(
      await fs.readFile(join(workspace, 'rounds', '2', 'generator', 'signals.json'), 'utf8')
    );
    expect(round2Signals.some((s: { type: string; text?: string }) => s.type === 'learning')).toBe(true);
    // progress.md APPENDS — the seeded header is preserved and the new run's separator +
    // attempt section grow underneath it.
    const md = await fs.readFile(f.progressFile, 'utf8');
    expect(md).toContain('# Sprint: kept');
    expect(md).toContain('## Task:');
    expect(md).toContain('_Sprint activated at');
  });

  it('multiple <commit-message> tags across turns: last one wins at commit time', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);
    const git = commitCapturingGit(1);

    // Two evaluator turns: first fails (forcing a second generator turn), second passes. Each
    // generator turn emits a distinct commit-message; the latest non-undefined wins on ctx.
    let implCalls = 0;
    let evalCalls = 0;
    const provider = createFakeAiProvider({
      signals: {
        implement: () => {
          implCalls += 1;
          if (implCalls === 1) {
            return [commitMessage('first attempt subject', 'first body'), taskVerified('turn 1')];
          }
          return [commitMessage('final subject', 'final body'), taskVerified('turn 2')];
        },
        evaluate: () => {
          evalCalls += 1;
          return evalCalls === 1 ? [evaluationFailed('not quite')] : [evaluationPassed()];
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir, git.runner),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );

    const chain = createRunner({
      id: 'r-impl-commit-msg-latest-wins',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await chain.start();

    expect(chain.status).toBe('completed');
    expect(implCalls).toBe(2);
    expect(evalCalls).toBe(2);
    expect(git.commitMessages()).toEqual(['final subject\n\nfinal body']);
  });

  // ─── Resilience: verify-script enforcement gates the commit ───────────────────────
  //
  // The harness's safety contract: even if the AI says `<task-verified>` and the evaluator
  // passes, a failing post-task verify script must BLOCK the task — no commit on the sprint
  // branch, no quiet pass. This is the primary "go-off-the-computer" guardrail and the
  // composition that powers it (post-task-verify → guard → commit-task → settle-attempt) only
  // gets exercised end-to-end here.
  it('regressed baseline (pre=green, post=red) on the LAST allowed attempt blocks the task and prevents the commit', async () => {
    // `maxAttempts: 1` so the single allowed attempt's regressed post-verify exhausts the retry
    // budget immediately (T6: `1 < 1` is false → block only). This pins the budget-exhausted half
    // of the policy — the regressed verify still blocks once retries run out, with no commit on red.
    const f = await buildFixture(1, 1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('looks great')],
        evaluate: [evaluationPassed()],
      },
    });

    // The shell runner is invoked once per setup-script, once per pre-task-verify, once per
    // post-task-verify. We need to return GREEN for the first pre-check (baseline is good) and
    // RED for the post-check — that's a `regressed` attribution, which DOES block. Setup is
    // skipped (no `setupScript`).
    let shellCallCount = 0;
    const regressingShell: ShellScriptRunner = {
      async run() {
        shellCallCount += 1;
        // Call 1 = pre-task-verify (green baseline). Call 2 = post-task-verify (red — regression).
        const isPost = shellCallCount >= 2;
        if (isPost) {
          return Result.ok({ passed: false, exitCode: 1, output: 'tests failed: 3 of 7\n', durationMs: 12 });
        }
        return Result.ok({ passed: true, exitCode: 0, output: 'all green\n', durationMs: 10 });
      },
    };

    // Wire a verifyScript on the repo so pre/post checks actually run.
    const reposWithCheck = new Map([
      [FIXED_REPOSITORY_ID, { path: FAKE_CWD, name: 'fake-repo', verifyScript: 'pnpm test' }],
    ]);

    const git = commitCapturingGit(1);
    const deps: ImplementDeps = {
      ...buildDeps(
        sprintRepo.repo,
        inMemoryExecutionRepo(f.execution).repo,
        taskRepo.repo,
        provider,
        f.dir,
        git.runner
      ),
      shellScriptRunner: regressingShell,
    };

    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: reposWithCheck,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });
    const runner = createRunner({
      id: 'r-impl-verify-failed',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('blocked');
    if (finalTask?.status === 'blocked') {
      // The block reason names the regression — operator sees what failed without digging through the audit log.
      expect(finalTask.blockedReason).toMatch(/regressed baseline|verify script failed/);
    }
    // Attribution row on the attempt records `'regressed'` — the deterministic verdict the TUI surfaces.
    expect(finalTask?.attempts.at(-1)?.attribution).toBe('regressed');
    // No commit landed on the branch — that's the whole point of the gate.
    expect(git.commitMessages()).toEqual([]);
    // Sprint stays active (no task settled `done`).
    expect(sprintRepo.current().status).not.toBe('review');
  });

  it('T6 red-post-verify retry: attempt 1 evaluator-passes but post-verify regresses → retry; attempt 2 post-verify green → done, rejected diff quarantined', async () => {
    // The headline T6 win: an evaluator-PASSED attempt whose harness post-verify regressed a green
    // baseline no longer blocks-and-waits-for-a-human while attempt budget remains. It retries the
    // SAME task with the failing post-verify output threaded into the next generator prompt, and
    // the rejected (red) diff is stashed so attempt 2 starts from the last good commit.
    //
    //   attempt 1: pre=green, post=RED (regressed) → commit skipped, diff quarantined, in_progress
    //   attempt 2: pre=green, post=green (clean)    → commit lands, task → done
    //
    // Two attempts recorded; the run completes without an operator; the sprint moves to review.
    const f = await buildFixture(1, 3); // cap 3 — budget remains after attempt 1
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    let implCalls = 0;
    let evalCalls = 0;
    const provider = createFakeAiProvider({
      signals: {
        // The generator always reports success; the evaluator always PASSES. The ONLY thing red on
        // attempt 1 is the harness post-verify — proving the retry is driven by the harness gate,
        // not by an evaluator-failed verdict (which the finalize/escalation path already covers).
        implement: () => {
          implCalls += 1;
          return [taskVerified('looks great')];
        },
        evaluate: () => {
          evalCalls += 1;
          return [evaluationPassed()];
        },
      },
    });

    // Per attempt the verify script runs twice: pre then post. So call sequence is
    // [a1-pre, a1-post, a2-pre, a2-post]. Attempt 1's post (call 2) is RED → regressed; every other
    // call is green. Attempt 2's post (call 4) is green → clean → done.
    let shellCallCount = 0;
    const retryThenPassShell: ShellScriptRunner = {
      async run() {
        shellCallCount += 1;
        const isAttempt1Post = shellCallCount === 2;
        if (isAttempt1Post) {
          return Result.ok({ passed: false, exitCode: 1, output: 'attempt 1 broke the build\n', durationMs: 12 });
        }
        return Result.ok({ passed: true, exitCode: 0, output: 'all green\n', durationMs: 10 });
      },
    };

    const reposWithCheck = new Map([
      [FIXED_REPOSITORY_ID, { path: FAKE_CWD, name: 'fake-repo', verifyScript: 'pnpm test' }],
    ]);

    // Dedicated git fake: attempt 1's red post skips the commit, so the quarantine stashes the
    // dirty tree; attempt 2 commits normally. We model the tree as dirty (the AI wrote files) until
    // either a commit OR a quarantine stash consumes the diff, then clean for the settle guardrail.
    const commitMessages: string[] = [];
    let head = 'main';
    let preflightStatusesRemaining = 2; // working-tree-clean-check + preflight-task (both clean)
    let treeClean = false; // flips true after a commit or a quarantine stash consumes the diff
    const retryGit: GitRunner = {
      async run(_, args) {
        if (args[0] === 'status' && args[1] === '--porcelain') {
          if (preflightStatusesRemaining > 0) {
            preflightStatusesRemaining -= 1;
            return okGit('', 0);
          }
          if (treeClean) {
            treeClean = false;
            return okGit('', 0);
          }
          return okGit(' M file\n', 0); // dirty — the AI's work sits in the tree
        }
        if (args[0] === 'add' && args[1] === '-A') return okGit('', 0);
        // Quarantine of attempt 1's rejected red diff: gitStashPush runs `status` (dirty, above)
        // then `stash push`. Consuming the diff leaves the tree clean for attempt 2's pre-verify.
        if (args[0] === 'stash' && args[1] === 'push') {
          treeClean = true;
          return okGit('Saved working directory\n', 0);
        }
        if (args[0] === 'commit' && args[1] === '-m') {
          commitMessages.push(args[2] ?? '');
          treeClean = true;
          return okGit('', 0);
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return okGit(`${'0'.repeat(40)}\n`, 0);
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return okGit(`${head}\n`, 0);
        if (args[0] === 'show-ref') return okGit('', 1);
        if (args[0] === 'checkout') {
          const target = args[1] === '-b' ? args[2] : args[1];
          if (target !== undefined) head = target;
          return okGit('', 0);
        }
        if (args[0] === 'diff' && args[1] === 'HEAD') return okGit('@@ -1 +1 @@\n-old\n+new\n', 0);
        if (args[0] === 'ls-files') return okGit('', 0);
        return okGit('', 0);
      },
    };

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir, retryGit),
      shellScriptRunner: retryThenPassShell,
    };

    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: reposWithCheck,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });
    const runner = createRunner({
      id: 'r-impl-red-post-verify-retry',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    // Two attempts ran in one launch — attempt 1 retried on the red post-verify, attempt 2 passed.
    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('done');
    expect(finalTask?.attempts).toHaveLength(2);
    // Attempt 1 settled `failed` (the granted retry); attempt 2 settled `verified` (the pass).
    expect(finalTask?.attempts[0]?.status).toBe('failed');
    expect(finalTask?.attempts.at(-1)?.status).toBe('verified');
    // The load-bearing trace assertion: start-attempt + settle-attempt each fired twice — proof the
    // loop genuinely re-entered (not a single attempt with two turns), AND the quarantine leaf ran
    // exactly once (attempt 1's rejected red diff was stashed, attempt 2's clean tree no-op'd it).
    const startEntries = runner.trace.filter((e) => e.elementName === `start-attempt-${String(finalTask?.id)}`);
    expect(startEntries).toHaveLength(2);
    const settleEntries = runner.trace.filter((e) => e.elementName === `settle-attempt-${String(finalTask?.id)}`);
    expect(settleEntries).toHaveLength(2);
    const quarantineEntries = runner.trace.filter(
      (e) => e.elementName === `quarantine-retry-diff-${String(finalTask?.id)}` && e.status === 'completed'
    );
    expect(quarantineEntries).toHaveLength(1);
    // Exactly ONE commit landed — attempt 2's green work. Attempt 1's red diff was never committed.
    expect(commitMessages).toHaveLength(1);
    // The generator ran twice (once per attempt); the evaluator passed both times.
    expect(implCalls).toBe(2);
    expect(evalCalls).toBe(2);
    // One done task → sprint moves to review.
    expect(sprintRepo.current().status).toBe('review');
  });

  it('baseline-broken (pre=red, post=red) preserves the AI verdict when operator has opted into the amnesty', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('looks great')],
        evaluate: [evaluationPassed()],
      },
    });

    // Both pre and post return red — pre-existing failure. The harness must NOT blame the AI
    // (attribution: 'baseline-broken') — task settles `done` so the operator can fix the
    // baseline without losing the AI's work. Under the operator-gate change, the silent
    // pass-through only kicks in once the operator has opted into the amnesty for this red
    // stretch (`SprintExecution.baselineBrokenPolicy = 'proceed'`); without the amnesty the
    // leaf would prompt (in TTY context) or hard-block (non-interactive — the e2e setup).
    const persistentlyRedShell: ShellScriptRunner = {
      async run() {
        return Result.ok({ passed: false, exitCode: 1, output: 'pre-existing failure\n', durationMs: 12 });
      },
    };

    const reposWithCheck = new Map([
      [FIXED_REPOSITORY_ID, { path: FAKE_CWD, name: 'fake-repo', verifyScript: 'pnpm test' }],
    ]);

    const git = commitCapturingGit(1);
    // Seed the execution with the amnesty already granted — simulates the operator having
    // picked "proceed anyway" on the first red task of this sprint. With the amnesty in
    // place, pre-task-verify falls through silently and the prior attribution-only behaviour
    // remains exercised by this regression test.
    const executionWithAmnesty = { ...f.execution, baselineBrokenPolicy: 'proceed' as const };
    const deps: ImplementDeps = {
      ...buildDeps(
        sprintRepo.repo,
        inMemoryExecutionRepo(executionWithAmnesty).repo,
        taskRepo.repo,
        provider,
        f.dir,
        git.runner
      ),
      shellScriptRunner: persistentlyRedShell,
    };

    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: reposWithCheck,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });
    const runner = createRunner({
      id: 'r-impl-baseline-broken',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    const finalTask = taskRepo.tasks()[0];
    // Task settles `done` — preserved verdict — even though both checks ran red.
    expect(finalTask?.status).toBe('done');
    // Attribution = baseline-broken — surfaced for the post-mortem.
    const lastAttempt = finalTask?.attempts.at(-1);
    expect(lastAttempt?.attribution).toBe('baseline-broken');
    expect(lastAttempt?.baselineBroken).toBe(true);
  });

  // ─── Resilience: AI emits no recognisable signals at all ──────────────────────────
  //
  // An overnight run could hit a model output that's plain prose with no harness tags —
  // missed prompt cue, model degradation, etc. Under the audit-[09] contract, the evaluator's
  // `signals.json` MUST carry exactly one `evaluation` signal (`exactlyOne('evaluation')`
  // refinement). A silent evaluator violates the schema; the evaluator turn converts that
  // recoverable ParseError into a self-block, so the TASK settles `blocked` (surfaced + re-
  // runnable) while the CHAIN completes cleanly without running away. This is the resilience
  // fix: one bad turn must not abort the whole run.
  it('AI emits zero harness signals: task blocks on the schema failure, chain completes, no infinite loop', async () => {
    const f = await buildFixture(1, 1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    let implCalls = 0;
    let evalCalls = 0;
    const provider = createFakeAiProvider({
      signals: {
        implement: () => {
          implCalls += 1;
          return [];
        },
        evaluate: () => {
          evalCalls += 1;
          return [];
        },
      },
    });

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      config: {
        harness: {
          maxTurns: 3,
          maxAttempts: 1,
          rateLimitRetries: 0,
          plateauThreshold: 2,
          escalateOnPlateau: false,
          escalationMap: {},
          skipPreVerifyOnFreshSetup: false,
        },
      },
    };
    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });
    const runner = createRunner({
      id: 'r-impl-silent-ai',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    // Schema violation in the evaluator surfaces as a recoverable ParseError → self-block →
    // the task settles `blocked` and the chain COMPLETES (does not abort). The point of THIS
    // test is that the chain doesn't hang in a runaway loop: each role is called at most
    // maxTurns (3) times.
    expect(runner.status).toBe('completed');
    expect(implCalls).toBeLessThanOrEqual(3);
    expect(evalCalls).toBeLessThanOrEqual(3);
    // Generator runs at least once; evaluator runs at least once (it's what surfaces the
    // schema error). Confirms the chain didn't short-circuit before invoking the AI at all.
    expect(implCalls).toBeGreaterThanOrEqual(1);
    expect(evalCalls).toBeGreaterThanOrEqual(1);

    // The lone task is blocked, not done — its ungraded change is never marked complete.
    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('blocked');
    if (finalTask?.status === 'blocked') {
      expect(finalTask.blockedReason).toContain('evaluator did not produce a valid signals.json');
    }
    // No task settled `done`, so the sprint stays `active` for a clean re-run.
    expect(sprintRepo.current().status).toBe('active');
  });

  // ─── Multi-repo project: each task gets its repo's cwd ────────────────────────────
  //
  // A project with two repositories has two task pools. `createImplementFlow` resolves the
  // repo per task via `resolveRepo(task)` and threads its `cwd` into branch-preflight,
  // generator/evaluator, post-task-verify, commit-task, settle-attempt. The unique-repo set
  // also drives `resolveBranchLeaf` (one checkout per repo) and `preflightTaskLeaf` (one
  // dirty-tree gate per repo). End-to-end coverage protects that wiring from regressing into
  // "everything points at the first repo" — a silent failure mode that would land commits
  // for both tasks on the same working tree.
  it('multi-repo: two tasks targeting different repositories each run against their own cwd', async () => {
    const ticket = makeApprovedTicket({ title: 'multi-repo-ticket' });
    const sprint = makePlannedSprint({ tickets: [ticket] });
    const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'ralphctl/multi-repo');

    const REPO_A_ID = FIXED_REPOSITORY_ID;
    const REPO_B_ID = repositoryId('01900000-0000-7000-8000-0000000000aa');
    const CWD_A = absolutePath('/tmp/ralph/repo-a');
    const CWD_B = absolutePath('/tmp/ralph/repo-b');

    const taskA = makeTodoTask({
      name: 'task-a',
      order: 1,
      ticketId: ticket.id,
      repositoryId: REPO_A_ID,
    });
    const taskB = makeTodoTask({
      name: 'task-b',
      order: 2,
      ticketId: ticket.id,
      repositoryId: REPO_B_ID,
    });
    const tasks: readonly Task[] = [taskA, taskB];

    const dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-impl-multi-')));
    const progressFile = join(dir, 'progress.md');
    cleanupFns.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    const sprintRepo = inMemorySprintRepo(sprint);
    const taskRepo = inMemoryTaskRepo(tasks);

    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('tests pass')],
        evaluate: [evaluationPassed()],
      },
    });

    // Custom git runner that tracks (cwd, args) per call so we can assert resolve-branch
    // and preflight-task fan out to each unique repo cwd. The fake tree is always clean —
    // no commits captured here; per-task cwd wiring is proved by the shell-runner probe
    // below (post-task-verify fires per-task with the task's repo cwd).
    interface GitCall {
      readonly cwd: string;
      readonly args: readonly string[];
    }
    const gitCalls: GitCall[] = [];
    let headA = 'main';
    let headB = 'main';
    const gitRunner: GitRunner = {
      async run(cwd, args): Promise<Result<GitRunResult, StorageError>> {
        gitCalls.push({ cwd: String(cwd), args });
        const isA = String(cwd) === String(CWD_A);
        if (args[0] === 'status' && args[1] === '--porcelain') return okGit('', 0);
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          return okGit(`${isA ? headA : headB}\n`, 0);
        }
        if (args[0] === 'show-ref') return okGit('', 1);
        if (args[0] === 'checkout') {
          const target = args[1] === '-b' ? args[2] : args[1];
          if (target !== undefined) {
            if (isA) headA = target;
            else headB = target;
          }
          return okGit('', 0);
        }
        if (args[0] === 'add' && args[1] === '-A') return okGit('', 0);
        if (args[0] === 'commit' && args[1] === '-m') return okGit('', 0);
        // restore-blocked-diff runs `stash list` per attempt — empty here (no prior quarantine).
        if (args[0] === 'stash' && args[1] === 'list') return okGit('', 0);
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return okGit('0000000000000000000000000000000000000000\n', 0);
        }
        // Evaluator-round work-product fingerprint — clean tree per repo, so an empty diff.
        if (args[0] === 'diff' && args[1] === 'HEAD') return okGit('', 0);
        if (args[0] === 'ls-files') return okGit('', 0); // fingerprint untracked probe — none here
        throw new Error(`multi-repo test: unscripted git args at ${String(cwd)}: ${args.join(' ')}`);
      },
    };

    // Shell runner captures (cwd, command). post-task-verify invokes this once per task with
    // the task's repo cwd — that's the per-task cwd-wiring smoking gun.
    interface ShellCall {
      readonly cwd: string;
      readonly command: string;
    }
    const shellCalls: ShellCall[] = [];
    const probingShell: ShellScriptRunner = {
      async run(cwd, command) {
        shellCalls.push({ cwd: String(cwd), command });
        return Result.ok({ passed: true, exitCode: 0, output: '', durationMs: 0 });
      },
    };

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(execution).repo, taskRepo.repo, provider, dir, gitRunner),
      shellScriptRunner: probingShell,
    };

    const flow = createImplementFlow(deps, {
      sprintId: sprint.id,
      todoTasks: tasks,
      repositories: new Map([
        [REPO_A_ID, { path: CWD_A, name: 'repo-a', verifyScript: 'pnpm test' }],
        [REPO_B_ID, { path: CWD_B, name: 'repo-b', verifyScript: 'pnpm test' }],
      ]),
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(progressFile),
      sprintDir: absolutePath(dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });
    const runner = createRunner({
      id: 'r-impl-multi-repo',
      element: flow,
      initialCtx: { sprintId: sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    // Both tasks settled `done`.
    const finalTasks = taskRepo.tasks();
    expect(finalTasks.map((t) => t.status)).toEqual(['done', 'done']);

    // Per-repo branch-checkout fan-out from resolve-branch: BOTH cwds get checked out onto
    // the sprint branch before any per-task work begins.
    const checkoutsByRepo = new Map<string, string[]>();
    for (const call of gitCalls) {
      if (call.args[0] !== 'checkout') continue;
      const target = call.args[1] === '-b' ? call.args[2] : call.args[1];
      const arr = checkoutsByRepo.get(call.cwd) ?? [];
      arr.push(String(target));
      checkoutsByRepo.set(call.cwd, arr);
    }
    expect(checkoutsByRepo.get(String(CWD_A))?.[0]).toBe('ralphctl/multi-repo');
    expect(checkoutsByRepo.get(String(CWD_B))?.[0]).toBe('ralphctl/multi-repo');

    // Per-repo dirty-tree preflight: each repo's `status --porcelain` is called.
    const statusCwds = new Set(
      gitCalls.filter((c) => c.args[0] === 'status' && c.args[1] === '--porcelain').map((c) => c.cwd)
    );
    expect(statusCwds.has(String(CWD_A))).toBe(true);
    expect(statusCwds.has(String(CWD_B))).toBe(true);

    // Per-task cwd-wiring: pre-task-verify + post-task-verify each fire once per task against
    // the task's repo, proving resolveRepo(task) wires the right cwd into the per-task
    // sub-chain (not "first repo wins for everything"). Two tasks × two checks = 4 calls.
    const shellCwds = shellCalls.map((c) => c.cwd);
    expect(shellCwds).toContain(String(CWD_A));
    expect(shellCwds).toContain(String(CWD_B));
    expect(shellCalls).toHaveLength(4);
    // Each repo received exactly 2 shell calls (pre + post).
    expect(shellCwds.filter((c) => c === String(CWD_A))).toHaveLength(2);
    expect(shellCwds.filter((c) => c === String(CWD_B))).toHaveLength(2);
  });

  // ─── Resilience: resume after a mid-evaluator crash ───────────────────────────────
  //
  // Failure model: the operator launched implement, the generator turn finished + wrote
  // rounds/1/generator/signals.json, then the host crashed (or got SIGKILL'd) BEFORE the
  // evaluator turn completed. On disk:
  //   - tasks.json shows the task as `in_progress` with a `running` attempt
  //   - rounds/1/generator/signals.json exists
  //   - rounds/1/evaluator/ does NOT exist (the evaluator never wrote)
  //
  // On the next launch the chain must:
  //   1. Settle the prior `running` attempt as `aborted` (start-attempt's resume path).
  //   2. Open a fresh attempt — total attempt count becomes 2.
  //   3. Compute nextRoundNum = 2 from disk (round 1's dir exists, so increment past it).
  //   4. Run gen+eval against round 2 without touching round 1's artifacts.
  //   5. Settle the new attempt as `verified`; task → done; sprint → review.
  it('resume after mid-evaluator crash: settles aborted attempt, starts fresh, preserves prior rounds', async () => {
    const ticket = makeApprovedTicket({ title: 'resume-ticket' });
    const sprint = makePlannedSprint({ tickets: [ticket] });
    const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'ralphctl/resume');

    // Build the task in the same state the prior crashed run left it: `in_progress` with one
    // running attempt carrying a sessionId from the prior session.
    const todo = makeTodoTask({
      name: 'crashy-task',
      order: 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
    });
    const startResult = startNextAttempt(todo, FIXED_NOW, 'prior-session');
    if (!startResult.ok) throw new Error(`test setup: startNextAttempt failed: ${startResult.error.message}`);
    const inProgress = startResult.value;
    const tasks: readonly Task[] = [inProgress];

    const dir = await realpath(await fs.mkdtemp(join(tmpdir(), 'ralphctl-impl-resume-')));
    const progressFile = join(dir, 'progress.md');
    cleanupFns.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    // Pre-seed the partial round-1 state: generator wrote, evaluator was killed before writing.
    const workspace = join(dir, 'implement', String(inProgress.id));
    const round1Gen = join(workspace, 'rounds', '1', 'generator');
    await fs.mkdir(round1Gen, { recursive: true });
    const priorSignals =
      '[{"type":"task-verified","output":"prior-gen-output","timestamp":"2026-05-08T10:00:00.000Z"}]';
    await fs.writeFile(join(round1Gen, 'signals.json'), priorSignals, 'utf8');

    const sprintRepo = inMemorySprintRepo(sprint);
    const taskRepo = inMemoryTaskRepo(tasks);

    // Fresh provider answers — the new attempt re-runs gen+eval cleanly.
    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('resumed run passes')],
        evaluate: [evaluationPassed()],
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(execution).repo, taskRepo.repo, provider, dir),
      {
        sprintId: sprint.id,
        todoTasks: tasks, // Resume contract: in_progress tasks ride along in `todoTasks`.
        repositories: new Map([[FIXED_REPOSITORY_ID, { path: FAKE_CWD, name: 'fake-repo' }]]),
        generatorProviderId: 'claude-code',
        generatorModel: 'claude-opus-4-8',
        evaluatorProviderId: 'claude-code',
        evaluatorModel: 'claude-opus-4-8',
        progressFile: absolutePath(progressFile),
        sprintDir: absolutePath(dir),
        memoryRoot: FAKE_MEMORY_ROOT,
        projectId: FAKE_PROJECT_ID,
      }
    );
    const runner = createRunner({
      id: 'r-impl-resume-crash',
      element: flow,
      initialCtx: { sprintId: sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    // Task settled `done` — the resumed run completed cleanly.
    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('done');
    if (finalTask?.status !== 'done') return;

    // Two attempts now: the prior `running` is settled as `aborted`, then a fresh attempt
    // ran and verified. That's the start-attempt resume contract.
    expect(finalTask.attempts).toHaveLength(2);
    expect(finalTask.attempts[0]?.status).toBe('aborted');
    // First attempt's prior sessionId is preserved (audit / cost attribution after the fact).
    expect(finalTask.attempts[0]?.sessionId).toBe('prior-session');
    expect(finalTask.attempts[1]?.status).toBe('verified');
    expect(finalTask.finalAttemptN).toBe(2);

    // Prior round-1 generator signals.json is byte-identical: resume never overwrites past
    // artifacts, so postmortem audits stay valid.
    expect(await fs.readFile(join(round1Gen, 'signals.json'), 'utf8')).toBe(priorSignals);

    // New attempt rounds started at N=2 (nextRoundNum read disk and incremented past round 1).
    const round2Gen = join(workspace, 'rounds', '2', 'generator', 'signals.json');
    const round2Eval = join(workspace, 'rounds', '2', 'evaluator', 'signals.json');
    await expect(fs.access(round2Gen)).resolves.toBeUndefined();
    await expect(fs.access(round2Eval)).resolves.toBeUndefined();
    const round2GenSignals = JSON.parse(await fs.readFile(round2Gen, 'utf8'));
    expect(round2GenSignals.some((s: { type: string }) => s.type === 'task-verified')).toBe(true);

    // Sprint advanced to review (≥1 task done).
    expect(sprintRepo.current().status).toBe('review');
  });

  // ─── outer attempt loop (up to maxAttempts attempts per launch) ─────────────────
  //
  // The per-task sub-chain wraps `start-attempt → … → settle → journal` in an outer
  // `loop('task-attempts-<id>', …)`. A single launch now runs up to `task.maxAttempts`
  // attempts instead of one. The loop stops when the settled task reaches a terminal status
  // (`done`/`blocked`) or the cap fires. These tests fence the new cadence: the escalation
  // path produces a genuine second attempt; `maxAttempts === 1` collapses to one iteration;
  // an abort propagates verbatim with no extra iteration.

  it('graduated ladder across attempts: sonnet plateaus → escalate to opus → opus plateaus → nudge → budget-exhausted preserves work', async () => {
    // maxAttempts 3 so the ladder can climb multiple rungs. Generator starts on a model
    // (`claude-sonnet-4-6`) that HAS a default escalation rung (→ `claude-opus-4-8`). The graduated
    // remedy ladder climbs one rung per plateau: attempt 1 (sonnet) escalates to opus, attempt 2
    // (opus, top of ladder) nudges (same model + change-of-approach directive), attempt 3 (opus)
    // plateaus with the budget exhausted (attempts === maxAttempts) — a plateau never blocks, so
    // the work is preserved (done-with-warning).
    const f = await buildFixture(1, 3);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    // Same failed dimension + identical critique every evaluator turn → plateau fires once the
    // window of `plateauThreshold` (2) consecutive turns agrees. Each attempt re-plateaus on
    // its own two turns because `start-attempt` clears `plateauHistory` per attempt.
    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('change made')],
        evaluate: [evaluationFailed('correctness: the same unchanged complaint about the parser')],
      },
    });

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      config: {
        harness: {
          maxTurns: 3,
          maxAttempts: 3,
          rateLimitRetries: 0,
          plateauThreshold: 2,
          escalateOnPlateau: true,
          escalationMap: {},
          skipPreVerifyOnFreshSetup: false,
        },
      },
    };
    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-sonnet-4-6',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });

    const runner = createRunner({
      id: 'r-impl-escalate-loop',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    // Three attempts ran in ONE launch — the outer loop re-entered after each escalate/nudge kept
    // the task in_progress. Attempt 1 escalated sonnet→opus, attempt 2 nudged (top of ladder),
    // attempt 3 plateaued with the budget exhausted — a plateau never blocks, so the work is
    // preserved (done-with-warning). All three attempts recorded.
    const finalTask = taskRepo.tasks()[0];
    expect(finalTask?.status).toBe('done');
    expect(finalTask?.attempts).toHaveLength(3);

    // The settle leaf ran once per attempt — exactly three `settle-attempt-<id>` trace entries.
    // This is the load-bearing assertion that each subsequent iteration's settle actually executed,
    // not merely that escalation was stamped.
    const settleEntries = runner.trace.filter((e) => e.elementName === `settle-attempt-${String(finalTask?.id)}`);
    expect(settleEntries).toHaveLength(3);
    // start-attempt fired three times too — once per loop iteration.
    const startEntries = runner.trace.filter((e) => e.elementName === `start-attempt-${String(finalTask?.id)}`);
    expect(startEntries).toHaveLength(3);

    // The ladder climbed to the top and the last stamp is the top-of-ladder same-model nudge
    // (from === to === opus). A plateau never blocks; the work is preserved (done-with-warning).
    expect(finalTask?.escalatedFromModel).toBe('claude-opus-4-8');
    expect(finalTask?.escalatedToModel).toBe('claude-opus-4-8');
    expect(finalTask?.status).not.toBe('blocked');

    // The generator climbed the ladder: attempt 1 ran on sonnet, later attempts ran on the
    // escalated opus model — proof later iterations didn't just re-run identical work.
    const generatorModels = provider.recordedSessions.filter((s) => s.role === 'generator').map((s) => s.model);
    expect(generatorModels).toContain('claude-sonnet-4-6');
    expect(generatorModels).toContain('claude-opus-4-8');

    // The plateau preserved the work as `done`, so the run finished and the sprint moves to review.
    expect(sprintRepo.current().status).toBe('review');
  });

  it('maxAttempts === 1: the outer loop runs exactly one iteration (single-attempt-per-launch parity)', async () => {
    // Regression guard for the byte-for-byte parity claim. Even with escalation ON and a model
    // that has a rung, a `maxAttempts` of 1 must collapse the outer loop to a single iteration:
    // attempt 1 plateaus, the escalation budget is already exhausted (attempts === maxAttempts),
    // the work is preserved (done-with-warning), and the loop stops. The escalated model is never spawned.
    const f = await buildFixture(1, 1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      signals: {
        implement: [taskVerified('change made')],
        evaluate: [evaluationFailed('correctness: the same unchanged complaint about the parser')],
      },
    });

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      config: {
        harness: {
          maxTurns: 3,
          maxAttempts: 1,
          rateLimitRetries: 0,
          plateauThreshold: 2,
          escalateOnPlateau: true,
          escalationMap: {},
          skipPreVerifyOnFreshSetup: false,
        },
      },
    };
    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-sonnet-4-6',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });

    const runner = createRunner({
      id: 'r-impl-single-attempt',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    const finalTask = taskRepo.tasks()[0];
    // Exactly one attempt — the loop did not re-enter.
    expect(finalTask?.attempts).toHaveLength(1);
    const settleEntries = runner.trace.filter((e) => e.elementName === `settle-attempt-${String(finalTask?.id)}`);
    expect(settleEntries).toHaveLength(1);
    const startEntries = runner.trace.filter((e) => e.elementName === `start-attempt-${String(finalTask?.id)}`);
    expect(startEntries).toHaveLength(1);

    // Plateau on the only allowed attempt (budget-exhausted) preserves the work as `done` — never
    // escalated, and the escalated model was never spawned — only sonnet ran.
    expect(finalTask?.status).toBe('done');
    expect(finalTask?.escalatedToModel).toBeUndefined();
    const generatorModels = provider.recordedSessions.filter((s) => s.role === 'generator').map((s) => s.model);
    expect(generatorModels.every((m) => m === 'claude-sonnet-4-6')).toBe(true);

    // One done task → the run finished and the sprint moves to review.
    expect(sprintRepo.current().status).toBe('review');
  });

  it('abort mid-loop: AbortError propagates and no second attempt iteration starts', async () => {
    // The outer attempt loop must propagate AbortError verbatim and never start another
    // iteration after a cancellation. We trip the abort from inside the FIRST generator spawn
    // (the runner owns the AbortController; the fake provider triggers `runner.abort()`), which
    // the generator leaf observes as `signal.aborted` immediately after its use case returns.
    const f = await buildFixture(1, 3);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    // A const holder lets the fake provider reach the runner that is constructed later. The
    // first generator spawn aborts; if any second iteration were to start, a second generator
    // spawn would fire and we'd see implCalls climb past 1.
    const runnerHolder: { current: ReturnType<typeof createRunner<ImplementCtx>> | undefined } = {
      current: undefined,
    };
    let implCalls = 0;
    let evalCalls = 0;
    const provider = createFakeAiProvider({
      signals: {
        implement: () => {
          implCalls += 1;
          runnerHolder.current?.abort('test-abort');
          return [taskVerified('change made')];
        },
        evaluate: () => {
          evalCalls += 1;
          return [evaluationPassed()];
        },
      },
    });

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      config: {
        harness: {
          maxTurns: 3,
          maxAttempts: 3,
          rateLimitRetries: 0,
          plateauThreshold: 2,
          escalateOnPlateau: false,
          escalationMap: {},
          skipPreVerifyOnFreshSetup: false,
        },
      },
    };
    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      generatorProviderId: 'claude-code',
      generatorModel: 'claude-opus-4-8',
      evaluatorProviderId: 'claude-code',
      evaluatorModel: 'claude-opus-4-8',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
      memoryRoot: FAKE_MEMORY_ROOT,
      projectId: FAKE_PROJECT_ID,
    });

    const runner = createRunner({
      id: 'r-impl-abort-loop',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    runnerHolder.current = runner;
    await runner.start();

    // The runner surfaces the AbortError as `aborted` status (caller-driven abort).
    expect(runner.status).toBe('aborted');
    // An `aborted` trace entry carrying an AbortError is present — propagated verbatim from the
    // generator leaf up through the inner sequential, the attempt loop, and the runner. (The
    // trace tail after it is `skipped` entries for the remaining same-attempt siblings, which is
    // how the sequential primitive records the short-circuit — not a second iteration.)
    const abortedEntries = runner.trace.filter((e) => e.status === 'aborted');
    expect(abortedEntries.length).toBeGreaterThanOrEqual(1);
    expect(abortedEntries.every((e) => e.error?.code === 'aborted')).toBe(true);

    // The generator spawned exactly once and the evaluator never ran — the abort hit before the
    // evaluator step and, crucially, BEFORE any second loop iteration. A second iteration would
    // have re-run `start-attempt` and the generator, climbing these counters past 1 / above 0.
    expect(implCalls).toBe(1);
    expect(evalCalls).toBe(0);
    const startEntries = runner.trace.filter((e) => e.elementName === `start-attempt-${String(f.tasks[0]?.id)}`);
    expect(startEntries).toHaveLength(1);
    // No second attempt's gen-eval ran: the generator leaf appears at most once (the iteration
    // that aborted). A leaked second loop iteration would re-emit it.
    const generatorEntries = runner.trace.filter((e) => e.elementName === `generator-${String(f.tasks[0]?.id)}`);
    expect(generatorEntries.length).toBeLessThanOrEqual(1);
  });
});
