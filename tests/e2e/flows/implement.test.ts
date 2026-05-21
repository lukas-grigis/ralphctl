import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  absolutePath,
  FIXED_LATER,
  FIXED_REPOSITORY_ID,
  makeApprovedTicket,
  makePlannedSprint,
  makeTodoTask,
  repositoryId,
} from '@tests/fixtures/domain.ts';
import { createSprintExecution, setExecutionBranch } from '@src/domain/entity/sprint-execution.ts';
import { startNextAttempt } from '@src/domain/entity/task.ts';
import { FIXED_NOW } from '@tests/fixtures/domain.ts';
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
import { createFsChainLogLoader } from '@src/integration/persistence/sprint/load-chain-log.ts';
import { createFsDecisionsLogLoader } from '@src/integration/persistence/sprint/load-decisions-log.ts';

const FAKE_CWD = absolutePath('/tmp/ralph/fake-cwd');
const FAKE_REPOSITORIES = new Map([[FIXED_REPOSITORY_ID, { path: FAKE_CWD }]]);

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
  provider: ImplementDeps['provider'],
  locksRoot: string,
  gitRunner: GitRunner = cleanGit
): ImplementDeps => ({
  sprintRepo,
  sprintExecutionRepo: executionRepo,
  taskRepo,
  provider,
  templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
  signals: createInMemorySink<HarnessSignal>(),
  eventBus: createInMemoryEventBus(),
  logger: noopLogger,
  clock: () => FIXED_LATER,
  config: { harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 0, plateauThreshold: 2 } },
  gitRunner,
  shellScriptRunner: passingShell,
  fileLocker: createFileLocker(),
  locksRoot: absolutePath(locksRoot),
  skillsAdapter: noopSkillsAdapter,
  skillSource: emptySkillSource,
  interactive: unusedInteractive,
  loadChainLog: createFsChainLogLoader(),
  loadDecisionsLog: createFsDecisionsLogLoader(),
  writeFile: createAtomicWriteFile(),
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
      responses: {
        implement: '<task-verified>tests pass</task-verified>',
        evaluate: '<evaluation-passed>',
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
      responses: {
        implement: '<task-verified>tests pass</task-verified>',
        evaluate: '<evaluation-passed>',
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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

  it('pass-after-retry: turn 1 fails, turn 2 passes — single attempt, two recorded turns', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    let evalCalls = 0;
    const provider = createFakeAiProvider({
      responses: {
        implement: '<task-verified>tests pass</task-verified>',
        evaluate: () => {
          evalCalls += 1;
          return evalCalls === 1 ? '<evaluation-failed>missing edge case</evaluation-failed>' : '<evaluation-passed>';
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
    const provider = createFakeAiProvider({
      responses: {
        implement: () => {
          implementCalls += 1;
          return '<task-verified>tests pass</task-verified>';
        },
        evaluate: () => {
          evalCalls += 1;
          return '<evaluation-failed>still wrong</evaluation-failed>';
        },
      },
    });

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      config: { harness: { maxTurns: 3, maxAttempts: 3, rateLimitRetries: 0, plateauThreshold: 2 } },
    };
    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      model: 'claude-opus-4-7',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
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
      responses: {
        implement: '<task-blocked>missing API key</task-blocked>',
        evaluate: () => {
          evalCalls += 1;
          return '<evaluation-passed>';
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
      responses: {
        implement: () => {
          implCalls += 1;
          return implCalls === 1
            ? '<task-blocked>cannot find dep</task-blocked>'
            : '<task-verified>second task complete</task-verified>';
        },
        evaluate: () => {
          evalCalls += 1;
          return '<evaluation-passed>';
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
    const idxEnsure = elementNames.indexOf('ensure-progress-file');
    const idxResolveBranch = elementNames.indexOf('resolve-branch');
    const idxWorkingTreeClean = elementNames.findIndex((n) => n.startsWith('working-tree-clean-check-'));
    const idxSetupScript = elementNames.indexOf('setup-script-runner');
    const idxSaveTasks = elementNames.indexOf('save-tasks');
    const idxTransition = elementNames.indexOf('transition-sprint-to-review');
    expect(idxLoadSprint).toBeGreaterThanOrEqual(0);
    expect(idxAssert).toBeGreaterThan(idxLoadSprint);
    expect(idxLoadExec).toBeGreaterThan(idxAssert);
    expect(idxLoadTasks).toBeGreaterThan(idxLoadExec);
    expect(idxEnsure).toBeGreaterThan(idxLoadTasks);
    // Pre-setup gate: resolve-branch + working-tree-clean-check land BEFORE setup-script-runner
    // so the user sees branch + dirty-tree problems surfaced before a multi-minute setup script
    // runs. The interactive preflight-task gate stays downstream of setup as a recovery seam.
    expect(idxResolveBranch).toBeGreaterThan(idxEnsure);
    expect(idxWorkingTreeClean).toBeGreaterThan(idxResolveBranch);
    expect(idxSetupScript).toBeGreaterThan(idxWorkingTreeClean);
    expect(idxSaveTasks).toBeGreaterThan(idxSetupScript);
    expect(idxTransition).toBeGreaterThan(idxSaveTasks);

    // Per-task entries appear in factory order — task-<id1> before task-<id2>.
    const startEntries = elementNames.filter((n) => n.startsWith('start-attempt-'));
    expect(startEntries[0]).toContain(String(f.tasks[0]?.id));
    expect(startEntries[1]).toContain(String(f.tasks[1]?.id));
  });

  it('proposed <commit-message> signal: harness commits with subject+body, not the default factory', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);
    const git = commitCapturingGit(1);

    const provider = createFakeAiProvider({
      responses: {
        implement: [
          '<commit-message>',
          '  <subject>add user-id index</subject>',
          '  <body>Speeds up the session lookup hot path.</body>',
          '</commit-message>',
          '<task-verified>tests pass</task-verified>',
        ].join('\n'),
        evaluate: '<evaluation-passed>',
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir, git.runner),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
      responses: {
        implement: '<task-verified>tests pass</task-verified>',
        evaluate: '<evaluation-passed>',
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir, git.runner),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
      responses: {
        implement: '<task-verified>gen body</task-verified>\n<note>gen-note</note>',
        evaluate: '<evaluation-passed>',
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
    await expect(fs.access(join(workspace, 'done-criteria.md'))).resolves.toBeUndefined();

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
    expect(evaluationMd).toContain('**Status:** passed');
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
      responses: {
        implement: () => {
          implCalls += 1;
          return implCalls === 1
            ? '<task-verified>first body</task-verified>'
            : 'plain markdown with no signals at all';
        },
        evaluate: () => {
          evalCalls += 1;
          return evalCalls === 1 ? '<evaluation-failed>retry</evaluation-failed>' : '<evaluation-passed>';
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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

  it('progress.md is snapshot-rendered from the persisted sprint state after each settle', async () => {
    // The legacy streaming-sink behaviour (appending `<learning>` / `<progress-entry>` bullets
    // to `progress.md` mid-run) is gone — those signals now land in `rounds/<N>/<role>/signals.json`
    // and the AI's own audit tree. `progress.md` is regenerated from scratch at sprint start,
    // after every settle-attempt, and after the sprint transitions to review.
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      responses: {
        implement: [
          '<learning>sqlite expects explicit pragmas</learning>',
          '<task-verified>tests pass</task-verified>',
        ].join('\n'),
        evaluate: '<evaluation-passed>',
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
    // Snapshot shape: header + status + tasks table from the projection renderer.
    expect(md).toContain('# Sprint progress —');
    expect(md).toContain('## Status');
    expect(md).toContain('## Tasks');
    // Task transition is reflected — the snapshot fired after settle-attempt + after the
    // active → review transition.
    expect(md).toMatch(/status: review/);
    expect(md).toMatch(/1\/1 done/);
    // The AI-emitted learning signal is captured in the round's signals.json, not progress.md.
    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    const signals = await fs.readFile(
      join(f.dir, 'implement', String(task.id), 'rounds', '1', 'generator', 'signals.json'),
      'utf8'
    );
    expect(JSON.parse(signals).some((s: { type: string }) => s.type === 'learning')).toBe(true);
  });

  it('resume preserves prior round artifacts; progress.md is overwritten by the next snapshot (that IS the migration)', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    // Pre-seed a prior run: rounds/1/generator/ + a streaming-sink-era progress.md. The new
    // snapshot renderer overwrites the legacy content — no separate migration step.
    const task = f.tasks[0];
    if (task === undefined) throw new Error('test setup: missing task');
    const workspace = join(f.dir, 'implement', String(task.id));
    const round1Gen = join(workspace, 'rounds', '1', 'generator');
    await fs.mkdir(round1Gen, { recursive: true });
    await fs.writeFile(join(round1Gen, 'signals.json'), '[{"type":"prior"}]', 'utf8');
    await fs.writeFile(
      f.progressFile,
      '# Sprint progress\n\n## Learnings\n\n- 2026-05-13T00:00:00.000Z — prior learning kept\n\n## Decisions\n\n## Activity\n\n## Tasks\n',
      'utf8'
    );

    const provider = createFakeAiProvider({
      responses: {
        implement: '<learning>fresh learning</learning>\n<task-verified>tests pass</task-verified>',
        evaluate: '<evaluation-passed>',
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
    // progress.md is REGENERATED — the legacy streaming-sink bullet is gone, replaced by the
    // new projection-rendered snapshot reflecting the just-settled sprint state.
    const md = await fs.readFile(f.progressFile, 'utf8');
    expect(md).not.toContain('prior learning kept');
    expect(md).toContain('# Sprint progress —');
    expect(md).toContain('## Status');
    expect(md).toMatch(/status: review/);
  });

  it('multiple <commit-message> tags across turns: last one wins at commit time', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);
    const git = commitCapturingGit(1);

    // Two evaluator turns: first fails (forcing a second generator turn), second passes. Each
    // generator turn emits a distinct <commit-message>; the latest non-undefined wins on ctx.
    let implCalls = 0;
    let evalCalls = 0;
    const provider = createFakeAiProvider({
      responses: {
        implement: () => {
          implCalls += 1;
          if (implCalls === 1) {
            return [
              '<commit-message><subject>first attempt subject</subject><body>first body</body></commit-message>',
              '<task-verified>turn 1</task-verified>',
            ].join('\n');
          }
          return [
            '<commit-message><subject>final subject</subject><body>final body</body></commit-message>',
            '<task-verified>turn 2</task-verified>',
          ].join('\n');
        },
        evaluate: () => {
          evalCalls += 1;
          return evalCalls === 1 ? '<evaluation-failed>not quite</evaluation-failed>' : '<evaluation-passed>';
        },
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir, git.runner),
      {
        sprintId: f.sprint.id,
        todoTasks: f.tasks,
        repositories: FAKE_REPOSITORIES,
        model: 'claude-opus-4-7',
        progressFile: absolutePath(f.progressFile),
        sprintDir: absolutePath(f.dir),
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
  it('regressed baseline (pre=green, post=red) blocks the task and prevents the commit', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      responses: {
        implement: '<task-verified>looks great</task-verified>',
        evaluate: '<evaluation-passed>',
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
    const reposWithCheck = new Map([[FIXED_REPOSITORY_ID, { path: FAKE_CWD, verifyScript: 'pnpm test' }]]);

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
      model: 'claude-opus-4-7',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
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

  it('baseline-broken (pre=red, post=red) preserves the AI verdict — pre-existing failure does NOT block', async () => {
    const f = await buildFixture(1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    const provider = createFakeAiProvider({
      responses: {
        implement: '<task-verified>looks great</task-verified>',
        evaluate: '<evaluation-passed>',
      },
    });

    // Both pre and post return red — pre-existing failure. The harness must NOT blame the AI
    // (attribution: 'baseline-broken') — task settles `done` so the operator can fix the
    // baseline without losing the AI's work.
    const persistentlyRedShell: ShellScriptRunner = {
      async run() {
        return Result.ok({ passed: false, exitCode: 1, output: 'pre-existing failure\n', durationMs: 12 });
      },
    };

    const reposWithCheck = new Map([[FIXED_REPOSITORY_ID, { path: FAKE_CWD, verifyScript: 'pnpm test' }]]);

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
      shellScriptRunner: persistentlyRedShell,
    };

    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: reposWithCheck,
      model: 'claude-opus-4-7',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
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
  // missed prompt cue, model degradation, etc. The chain must not hang or crash; it should
  // surface a sensible terminal state so the operator sees what happened.
  it('AI emits zero harness signals: budget exhausts cleanly with a malformed warning, no infinite loop', async () => {
    const f = await buildFixture(1, 1);
    tracking(f);
    const sprintRepo = inMemorySprintRepo(f.sprint);
    const taskRepo = inMemoryTaskRepo(f.tasks);

    let implCalls = 0;
    let evalCalls = 0;
    const provider = createFakeAiProvider({
      responses: {
        implement: () => {
          implCalls += 1;
          return 'just prose, no tags';
        },
        evaluate: () => {
          evalCalls += 1;
          return 'also no tags here';
        },
      },
    });

    const deps: ImplementDeps = {
      ...buildDeps(sprintRepo.repo, inMemoryExecutionRepo(f.execution).repo, taskRepo.repo, provider, f.dir),
      config: { harness: { maxTurns: 3, maxAttempts: 1, rateLimitRetries: 0, plateauThreshold: 2 } },
    };
    const flow = createImplementFlow(deps, {
      sprintId: f.sprint.id,
      todoTasks: f.tasks,
      repositories: FAKE_REPOSITORIES,
      model: 'claude-opus-4-7',
      progressFile: absolutePath(f.progressFile),
      sprintDir: absolutePath(f.dir),
    });
    const runner = createRunner({
      id: 'r-impl-silent-ai',
      element: flow,
      initialCtx: { sprintId: f.sprint.id } satisfies ImplementCtx,
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Bounded number of turns — exactly what maxTurns says, no runaway.
    expect(implCalls).toBeLessThanOrEqual(3);
    expect(evalCalls).toBeLessThanOrEqual(3);
    const finalTask = taskRepo.tasks()[0];
    // Policy: only `<task-blocked>` from the generator → blocked. Everything else (incl. a
    // silent evaluator → malformed exit → budget collapses) → done with a structured warning.
    // The operator inspects the warning on next launch instead of the chain hanging or
    // crashing. That's the contract the resilience tests need to pin.
    expect(finalTask?.status).toBe('done');
    if (finalTask?.status === 'done') {
      const lastAttempt = finalTask.attempts.at(-1);
      // At least one attempt carries a non-pass warning so the operator sees what happened.
      expect(lastAttempt?.warning?.kind).toBeDefined();
    }
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
      responses: {
        implement: '<task-verified>tests pass</task-verified>',
        evaluate: '<evaluation-passed>',
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
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return okGit('0000000000000000000000000000000000000000\n', 0);
        }
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
        [REPO_A_ID, { path: CWD_A, verifyScript: 'pnpm test' }],
        [REPO_B_ID, { path: CWD_B, verifyScript: 'pnpm test' }],
      ]),
      model: 'claude-opus-4-7',
      progressFile: absolutePath(progressFile),
      sprintDir: absolutePath(dir),
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
      responses: {
        implement: '<task-verified>resumed run passes</task-verified>',
        evaluate: '<evaluation-passed>',
      },
    });

    const flow = createImplementFlow(
      buildDeps(sprintRepo.repo, inMemoryExecutionRepo(execution).repo, taskRepo.repo, provider, dir),
      {
        sprintId: sprint.id,
        todoTasks: tasks, // Resume contract: in_progress tasks ride along in `todoTasks`.
        repositories: new Map([[FIXED_REPOSITORY_ID, { path: FAKE_CWD }]]),
        model: 'claude-opus-4-7',
        progressFile: absolutePath(progressFile),
        sprintDir: absolutePath(dir),
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
});
