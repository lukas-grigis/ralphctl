/**
 * Integration tests for the execute-tasks step — specifically the scheduler
 * wiring introduced when `forEachTask` + the per-task pipeline replaced
 * the monolithic parallel/sequential executor.
 *
 * These are the cases where concurrency regressions hide:
 *   - Rate-limit pause/resume mid-run
 *   - Branch-preflight retries up to MAX_BRANCH_RETRIES
 *   - Post-task-check failures blocking further work in the same repo
 *   - Step-mode `between` hook prompting between tasks
 *   - Fail-fast drains in-flight tasks
 *   - In-progress task resumption (pullItems includes in_progress)
 *
 * The outer pipeline is driven end-to-end so the step trace + final
 * `executionSummary` can be asserted. Repeatability + speed: every test
 * runs without real timers; rate-limit cooldowns are auto-resumed via the
 * `onPause` callback before the scheduler's `waitIfPaused` resolves.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config, Sprint, Task, Ticket } from '@src/domain/models.ts';
import { SpawnError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort, SessionResult } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler.ts';
import type { HarnessEvent, SignalBusPort } from '@src/business/ports/signal-bus.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { createExecuteSprintPipeline, type ExecuteDeps } from '../execute.ts';
// Integration test: uses the real coordinator so rate-limit pause/resume
// semantics are exercised against production code, not a fake.
import { RateLimitCoordinator } from '@src/integration/ai/session/rate-limiter.ts';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
    projectId: 'proj-1',
    status: 'active',
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-1',
    title: 'T',
    requirementStatus: 'approved',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Task',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    repoId: 'repo-a',
    verified: false,
    evaluated: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    currentSprint: null,
    aiProvider: 'claude',
    editor: null,
    evaluationIterations: 0,
    ...overrides,
  };
}

function makeSpinner(): SpinnerHandle {
  return { succeed: () => undefined, fail: () => undefined, stop: () => undefined };
}

function makeLogger(): LoggerPort {
  const logger: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    warning: () => undefined,
    tip: () => undefined,
    header: () => undefined,
    separator: () => undefined,
    field: () => undefined,
    card: () => undefined,
    newline: () => undefined,
    dim: () => undefined,
    item: () => undefined,
    spinner: () => makeSpinner(),
    child: () => logger,
    time: () => () => undefined,
  };
  return logger;
}

function makeBus(sink: HarnessEvent[] = []): SignalBusPort {
  return {
    emit: (e) => sink.push(e),
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
}

function makeSignalParser(): SignalParserPort {
  return {
    parseSignals: () => [],
  };
}

function makeSignalHandler(): SignalHandlerPort {
  return {
    handleProgress: () => Promise.resolve(),
    handleEvaluation: () => Promise.resolve(),
    handleTaskBlocked: () => Promise.resolve(),
    handleNote: () => Promise.resolve(),
  } as unknown as SignalHandlerPort;
}

function makePromptBuilder(): PromptBuilderPort {
  return {
    buildTaskExecutionPrompt: () => 'prompt',
    buildFeedbackPrompt: () => 'feedback',
  } as unknown as PromptBuilderPort;
}

function makeParser(): OutputParserPort {
  return {
    parseExecutionSignals: () => ({ completed: true, verified: false }),
  } as unknown as OutputParserPort;
}

function makeFs(): FilesystemPort {
  // contract-negotiate writes the per-task contract via ensureDir/writeFile;
  // executeOneTask writes/cleans a per-task context file in the project dir.
  // The integration test doesn't care about file content — only that I/O
  // paths are present and non-throwing.
  return {
    getSprintDir: () => '/tmp/sprint',
    getProgressFilePath: () => '/tmp/sprint/progress.md',
    getProjectContextFilePath: (projectPath: string, sprintId: string, taskId: string) =>
      `${projectPath}/.ralphctl-sprint-${sprintId}-task-${taskId}-context.md`,
    ensureDir: () => Promise.resolve(),
    writeFile: () => Promise.resolve(),
    deleteFile: () => Promise.resolve(),
  } as unknown as FilesystemPort;
}

/**
 * Build a persistence stub with per-run task state kept in a mutable array.
 * The scheduler pulls fresh items on every tick, so the stub needs to return
 * the *current* list (not a frozen snapshot) and support `updateTaskStatus`
 * as a mutation.
 */
function makePersistence(init: { sprint: Sprint; tasks: Task[]; config?: Config }): {
  persistence: PersistencePort;
  stateTasks: Task[];
  calls: {
    updateTaskStatus: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
    getReadyTasks: ReturnType<typeof vi.fn>;
    saveSprint: ReturnType<typeof vi.fn>;
  };
} {
  const stateTasks: Task[] = init.tasks.map((t) => ({ ...t }));
  let sprintState = init.sprint;

  const updateTaskStatus = vi.fn((taskId: string, status: Task['status']) => {
    const target = stateTasks.find((t) => t.id === taskId);
    if (target) target.status = status;
    return Promise.resolve(target);
  });
  const updateTask = vi.fn((taskId: string, patch: Partial<Task>) => {
    const target = stateTasks.find((t) => t.id === taskId);
    if (target) Object.assign(target, patch);
    return Promise.resolve();
  });
  const getReadyTasks = vi.fn(() => {
    const doneIds = new Set(stateTasks.filter((t) => t.status === 'done').map((t) => t.id));
    return Promise.resolve(
      stateTasks.filter((t) => t.status === 'todo' && t.blockedBy.every((dep) => doneIds.has(dep)))
    );
  });
  const saveSprint = vi.fn((s: Sprint) => {
    sprintState = s;
    return Promise.resolve();
  });

  const persistence = {
    getSprint: () => Promise.resolve(sprintState),
    getTasks: () => Promise.resolve(stateTasks.map((t) => ({ ...t }))),
    getReadyTasks,
    getRemainingTasks: () => Promise.resolve(stateTasks.filter((t) => t.status !== 'done').map((t) => ({ ...t }))),
    reorderByDependencies: () => Promise.resolve(),
    updateTaskStatus,
    updateTask,
    saveSprint,
    activateSprint: () => Promise.resolve(sprintState),
    getConfig: () => Promise.resolve(init.config ?? makeConfig()),
    getProject: () =>
      Promise.resolve({
        id: 'proj-1',
        name: 'p',
        displayName: 'p',
        repositories: [
          { id: 'repo-a', name: 'a', path: '/repo/a' },
          { id: 'repo-b', name: 'b', path: '/repo/b' },
        ],
      }),
    getProjectById: () =>
      Promise.resolve({
        id: 'proj-1',
        name: 'p',
        displayName: 'p',
        repositories: [
          { id: 'repo-a', name: 'a', path: '/repo/a' },
          { id: 'repo-b', name: 'b', path: '/repo/b' },
        ],
      }),
    getRepoById: (repoId: string) => {
      const byId: Record<string, { path: string; name: string }> = {
        'repo-a': { path: '/repo/a', name: 'a' },
        'repo-b': { path: '/repo/b', name: 'b' },
      };
      const info = byId[repoId];
      if (!info) return Promise.reject(new Error(`unknown repo: ${repoId}`));
      return Promise.resolve({
        project: {
          id: 'proj-1',
          name: 'p',
          displayName: 'p',
          repositories: [
            { id: 'repo-a', name: 'a', path: '/repo/a' },
            { id: 'repo-b', name: 'b', path: '/repo/b' },
          ],
        },
        repo: { id: repoId, ...info },
      });
    },
    resolveRepoPath: (repoId: string) => {
      const byId: Record<string, string> = {
        'repo-a': '/repo/a',
        'repo-b': '/repo/b',
      };
      const p = byId[repoId];
      if (!p) return Promise.reject(new Error(`unknown repo: ${repoId}`));
      return Promise.resolve(p);
    },
    logProgress: () => Promise.resolve(),
    getProgress: () => Promise.resolve(''),
    getProgressSummary: () => Promise.resolve(''),
  } as unknown as PersistencePort;

  return {
    persistence,
    stateTasks,
    calls: { updateTaskStatus, updateTask, getReadyTasks, saveSprint },
  };
}

interface Scenario {
  sprint?: Sprint;
  tasks?: Task[];
  config?: Config;
  spawnImpl?: (taskId: string, callCount: number) => Promise<SessionResult>;
  verifyBranch?: ExternalPort['verifyBranch'];
  hasUncommittedChanges?: ExternalPort['hasUncommittedChanges'];
  runCheckScript?: ExternalPort['runCheckScript'];
  confirm?: UserInteractionPort['confirm'];
}

/**
 * Wire a full ExecuteDeps graph with minimal stubs, returning mutable
 * call-trackers for the interesting methods.
 */
function buildDeps(scenario: Scenario = {}): {
  deps: ExecuteDeps;
  events: HarnessEvent[];
  logs: { warnings: string[]; infos: string[] };
  spawnWithRetry: ReturnType<typeof vi.fn>;
  runCheckScript: ReturnType<typeof vi.fn>;
  verifyBranch: ReturnType<typeof vi.fn>;
  stateTasks: Task[];
  calls: {
    updateTaskStatus: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
  };
} {
  const sprint = scenario.sprint ?? makeSprint({ tickets: [makeTicket({ affectedRepoIds: ['repo-a'] })] });
  const tasks = scenario.tasks ?? [makeTask()];
  const config = scenario.config ?? makeConfig();

  const { persistence, stateTasks, calls } = makePersistence({ sprint, tasks, config });

  const events: HarnessEvent[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];

  const logger: LoggerPort = {
    ...makeLogger(),
    warning: (msg) => {
      warnings.push(msg);
    },
    info: (msg) => {
      infos.push(msg);
    },
  };

  // Per-task spawn call count. Reset each test.
  const callsByTask = new Map<string, number>();
  const defaultSpawn: (taskId: string, count: number) => Promise<SessionResult> = () =>
    Promise.resolve({
      output: '<task-complete/>',
      sessionId: 'sess',
      model: 'claude-sonnet',
    } as SessionResult);
  const spawnImpl = scenario.spawnImpl ?? defaultSpawn;
  const spawnWithRetry = vi.fn((prompt: string, opts: { cwd: string }) => {
    // Extract task id from prompt — our makePromptBuilder returns a static
    // string, so callers identify tasks via cwd (projectPath) when needed.
    // Simpler: correlate via the stateTasks that are currently in_progress.
    // opts.cwd is the resolved repo path. Map back to a task via repoId.
    const repoIdByPath: Record<string, string> = { '/repo/a': 'repo-a', '/repo/b': 'repo-b' };
    const repoId = repoIdByPath[opts.cwd];
    const inFlight = stateTasks.find((t) => t.status === 'in_progress' && t.repoId === repoId);
    const taskId = inFlight?.id ?? 'unknown';
    const count = (callsByTask.get(taskId) ?? 0) + 1;
    callsByTask.set(taskId, count);
    void prompt;
    return spawnImpl(taskId, count);
  });

  const aiSession = {
    ensureReady: () => Promise.resolve(),
    getProviderDisplayName: () => 'Claude',
    getSpawnEnv: () => ({}),
    spawnWithRetry,
    spawnInteractive: () => Promise.resolve(),
  } as unknown as AiSessionPort;

  const runCheckScript = scenario.runCheckScript ?? vi.fn(() => Promise.resolve({ passed: true, output: '' }));
  const verifyBranch = scenario.verifyBranch ?? vi.fn(() => true);
  const hasUncommittedChanges = scenario.hasUncommittedChanges ?? (() => false);

  const external = {
    runCheckScript,
    verifyBranch,
    hasUncommittedChanges,
    generateBranchName: (sid: string) => `ralphctl/${sid}`,
    isValidBranchName: () => true,
    getCurrentBranch: () => 'main',
    createAndCheckoutBranch: () => undefined,
    getRecentGitHistory: () => 'no commits yet',
    detectProjectTooling: () => '',
  } as unknown as ExternalPort;

  const ui = {
    confirm: scenario.confirm ?? vi.fn(() => Promise.resolve(true)),
    selectBranchStrategy: () => Promise.resolve(null),
    getFeedback: () => Promise.resolve(null),
  } as unknown as UserInteractionPort;

  const deps: ExecuteDeps = {
    persistence,
    fs: makeFs(),
    aiSession,
    promptBuilder: makePromptBuilder(),
    parser: makeParser(),
    ui,
    logger,
    external,
    signalParser: makeSignalParser(),
    signalHandler: makeSignalHandler(),
    signalBus: makeBus(events),
    createRateLimitCoordinator: () => new RateLimitCoordinator(),
    processLifecycle: {
      ensureHandlers: () => void 0,
      isShuttingDown: () => false,
      registerAbort: () => () => void 0,
    },
    prompt: {
      select: () => Promise.reject(new Error('select not stubbed')),
      confirm: () => Promise.reject(new Error('confirm not stubbed')),
      input: () => Promise.reject(new Error('input not stubbed')),
      checkbox: () => Promise.reject(new Error('checkbox not stubbed')),
      editor: () => Promise.resolve(null),
      fileBrowser: () => Promise.resolve(null),
    },
    isTTY: () => false,
  };

  // Parser needs to produce a `task-complete` signal so `executeOneTask`
  // reports `success: true`. Override the signalParser's parseSignals to
  // return whatever the AI output contains — for tests, the default spawn
  // output `<task-complete/>` resolves to one TaskCompleteSignal.
  const signalParser: SignalParserPort = {
    parseSignals: (output: string) => {
      const signals: ({ type: string } & Record<string, unknown>)[] = [];
      if (output.includes('<task-complete')) signals.push({ type: 'task-complete' });
      if (output.includes('<task-verified')) {
        const match = /<task-verified>([\s\S]*?)<\/task-verified>/.exec(output);
        signals.push({ type: 'task-verified', output: match?.[1] ?? '' });
      }
      if (output.includes('<task-blocked')) {
        const match = /<task-blocked>([\s\S]*?)<\/task-blocked>/.exec(output);
        signals.push({ type: 'task-blocked', reason: match?.[1] ?? 'blocked' });
      }
      return signals as never;
    },
  };
  deps.signalParser = signalParser;

  return {
    deps,
    events,
    logs: { warnings, infos },
    spawnWithRetry,
    runCheckScript: runCheckScript as ReturnType<typeof vi.fn>,
    verifyBranch: verifyBranch as ReturnType<typeof vi.fn>,
    stateTasks,
    calls: { updateTaskStatus: calls.updateTaskStatus, updateTask: calls.updateTask },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeTasksStep via forEachTask — integration', () => {
  it('happy path: step trace includes execute-tasks and feedback-loop; summary is all_completed', async () => {
    const task = makeTask();
    const { deps } = buildDeps({ tasks: [task] });

    const pipeline = createExecuteSprintPipeline(deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.stepResults.map((r) => r.stepName)).toEqual([
      'load-sprint',
      'check-preconditions',
      'resolve-branch',
      'auto-activate',
      'assert-active',
      'prepare-tasks',
      'ensure-branches',
      'run-check-scripts',
      'execute-tasks',
      'feedback-loop',
    ]);

    expect(result.value.context.executionSummary).toMatchObject({
      completed: 1,
      remaining: 0,
      blocked: 0,
      stopReason: 'all_completed',
      exitCode: 0,
    });
  });

  it('rate-limit pause: first spawn rate-limits, scheduler pauses, second spawn succeeds', async () => {
    const task = makeTask();
    const spawnImpl = vi.fn((_taskId: string, count: number): Promise<SessionResult> => {
      if (count === 1) {
        // `retry-after: 1` → retryAfterMs = 1_000ms. Small enough to keep
        // the test fast, large enough that the scheduler's next tick
        // observes `isPaused` and so fires `onResume` when the coordinator
        // resumes on the timer.
        return Promise.reject(
          new SpawnError('rate limited', 'rate limit exceeded\nretry-after: 1', 1, 'resume-session-abc')
        );
      }
      return Promise.resolve({
        output: '<task-complete/>',
        sessionId: 'sess',
        model: 'claude-sonnet',
      } as SessionResult);
    });
    const { deps, events, logs, spawnWithRetry } = buildDeps({ tasks: [task], spawnImpl });

    const pipeline = createExecuteSprintPipeline(deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Scheduler paused then resumed, and the task ultimately completed.
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('rate-limit-paused');
    expect(eventTypes).toContain('rate-limit-resumed');
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(result.value.context.executionSummary?.stopReason).toBe('all_completed');
    // Session-id capture log parity.
    expect(logs.infos.some((l) => l.includes('Session saved for resume: resume-s'))).toBe(true);
    // The resume log line fires once, on the second launch.
    expect(logs.infos.some((l) => l.includes('Resuming previous session: resume-s'))).toBe(true);
    // The second spawn actually receives `resumeSessionId` — the harness
    // threads the captured ID back through the adapter so the provider
    // builds `--resume <id>`. Previously the map was logging-only.
    const spawnCalls = spawnWithRetry.mock.calls as [unknown, { resumeSessionId?: string }][];
    expect(spawnCalls[0]?.[1]?.resumeSessionId).toBeUndefined();
    expect(spawnCalls[1]?.[1]?.resumeSessionId).toBe('resume-session-abc');
  });

  it('branch mismatch: requeues up to 3 times then fails with task_blocked', async () => {
    const task = makeTask();
    const sprint = makeSprint({
      branch: 'feature/x',
      tickets: [makeTicket({ affectedRepoIds: ['repo-a'] })],
    });
    // verifyBranch always returns false — the branch never matches.
    const verifyBranch = vi.fn(() => false);
    const { deps, spawnWithRetry } = buildDeps({ tasks: [task], sprint, verifyBranch });

    const pipeline = createExecuteSprintPipeline(deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The retryPolicy retries 2 times before giving up on the 3rd attempt.
    expect(verifyBranch).toHaveBeenCalledTimes(3);
    // executeOneTask should never fire because branch-preflight blocks
    // launch on every attempt.
    expect(spawnWithRetry).not.toHaveBeenCalled();
    expect(result.value.context.executionSummary?.stopReason).toBe('task_blocked');
    expect(result.value.context.executionSummary?.exitCode).toBe(1);
  });

  it('post-task-check failure: marks repo failed, scheduler stops when no sibling repos', async () => {
    const task = makeTask();
    // runCheckScript: sprint-start passes, task-complete fails.
    const runCheckScript = vi.fn((_path: string, _script: string, phase: string) => {
      if (phase === 'sprintStart') return Promise.resolve({ passed: true, output: '' });
      return Promise.resolve({ passed: false, output: 'lint failed' });
    });

    const scenario = buildDeps({
      tasks: [task],
      runCheckScript: runCheckScript,
    });
    // Patch its persistence so the post-task-check gate resolves a repo
    // with a `checkScript` — otherwise `runPostTaskCheck` short-circuits
    // (no script configured → passes).
    const projectWithScript = {
      id: 'proj-1',
      name: 'p',
      displayName: 'p',
      repositories: [{ id: 'repo-a', name: 'a', path: '/repo/a', checkScript: 'pnpm lint' }],
    };
    const repoWithScript = projectWithScript.repositories[0];
    (
      scenario.deps.persistence as unknown as {
        getProject: () => Promise<unknown>;
        getRepoById: (repoId: string) => Promise<unknown>;
      }
    ).getProject = () => Promise.resolve(projectWithScript);
    (
      scenario.deps.persistence as unknown as {
        getRepoById: (repoId: string) => Promise<unknown>;
      }
    ).getRepoById = () => Promise.resolve({ project: projectWithScript, repo: repoWithScript });

    const pipeline = createExecuteSprintPipeline(scenario.deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Task stayed in_progress — mark-done never ran after the gate failed.
    const task1 = scenario.stateTasks.find((t) => t.id === 't1');
    expect(task1?.status).toBe('in_progress');
    expect(result.value.context.executionSummary?.stopReason).toBe('task_blocked');
  });

  it('step mode: between hook prompts between tasks (and stop aborts remaining work)', async () => {
    const taskA = makeTask({ id: 't1', order: 1, repoId: 'repo-a' });
    const taskB = makeTask({ id: 't2', order: 2, repoId: 'repo-b' });

    const confirm = vi.fn(() => Promise.resolve(false)); // user stops after first task
    const { deps, spawnWithRetry } = buildDeps({
      tasks: [taskA, taskB],
      sprint: makeSprint({
        tickets: [makeTicket({ affectedRepoIds: ['repo-a', 'repo-b'] })],
      }),
      confirm,
    });

    const pipeline = createExecuteSprintPipeline(deps, { step: true, noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The prompt fired once — between the first completion and the second
    // launch. `false` response stops the scheduler.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(spawnWithRetry).toHaveBeenCalledTimes(1);
    // Summary reflects partial progress (1 of 2).
    const summary = result.value.context.executionSummary;
    expect(summary?.completed).toBe(1);
    expect(summary?.remaining).toBe(1);
    expect(summary?.stopReason).toBe('user_paused');
  });

  it('in-progress task resumption: pullItems includes tasks that are already in_progress on restart', async () => {
    // Seed one task as in_progress — simulates a crash/recovery scenario.
    const task = makeTask({ status: 'in_progress' });
    const { deps, spawnWithRetry } = buildDeps({ tasks: [task] });

    const pipeline = createExecuteSprintPipeline(deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The task was picked up + completed even though it was never `todo`.
    expect(spawnWithRetry).toHaveBeenCalledTimes(1);
    expect(result.value.context.executionSummary?.stopReason).toBe('all_completed');
  });

  it('--concurrency 1 forces sequential: two tasks on different repos never overlap', async () => {
    const taskA = makeTask({ id: 't1', order: 1, repoId: 'repo-a' });
    const taskB = makeTask({ id: 't2', order: 2, repoId: 'repo-b' });

    let maxInFlight = 0;
    let inFlightNow = 0;
    const spawnImpl = async (): Promise<SessionResult> => {
      inFlightNow++;
      maxInFlight = Math.max(maxInFlight, inFlightNow);
      // Yield so the scheduler has a chance to try launching a second task.
      await new Promise((r) => setTimeout(r, 10));
      inFlightNow--;
      return { output: '<task-complete/>', sessionId: 'sess', model: 'claude-sonnet' };
    };
    const { deps } = buildDeps({
      tasks: [taskA, taskB],
      sprint: makeSprint({
        tickets: [makeTicket({ affectedRepoIds: ['repo-a', 'repo-b'] })],
      }),
      spawnImpl,
    });

    const pipeline = createExecuteSprintPipeline(deps, { concurrency: 1, noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Cancellation — regression fence for the bug where cancelling a
  // backgrounded execution left the Claude subprocess running and reported
  // `task_blocked` / `user_paused` instead of `cancelled`, and left tasks
  // stuck in `in_progress` forever.
  // -------------------------------------------------------------------------

  it('cancellation: aborted before any spawn → scheduler emits cancelled summary with exitCode 130', async () => {
    // Abort mid-pipeline but after `load-sprint` has run, so the outer
    // pipeline reaches `execute-tasks` and the scheduler's own cancellation
    // semantics kick in. `prepare-tasks`'s post-hook is a convenient seam —
    // it fires just before the scheduler starts.
    const task = makeTask();
    const scenario = buildDeps({ tasks: [task] });

    const ac = new AbortController();
    // Abort the moment getReadyTasks is first consulted — that happens
    // inside `execute-tasks`'s pullItems tick, so the scheduler enters
    // runScheduler with an already-aborted signal and short-circuits on
    // the initial abort check before launching any task.
    let aborted = false;
    const persistenceWithSchedulerHook = scenario.deps.persistence as unknown as {
      getReadyTasks: PersistencePort['getReadyTasks'];
    };
    const originalGetReady = persistenceWithSchedulerHook.getReadyTasks.bind(scenario.deps.persistence);
    persistenceWithSchedulerHook.getReadyTasks = vi.fn(async (sprintId: string) => {
      if (!aborted) {
        aborted = true;
        ac.abort();
      }
      return originalGetReady(sprintId);
    });

    const pipeline = createExecuteSprintPipeline(scenario.deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1', abortSignal: ac.signal });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(scenario.spawnWithRetry).not.toHaveBeenCalled();
    expect(result.value.context.executionSummary).toMatchObject({
      stopReason: 'cancelled',
      exitCode: 130,
    });
  });

  it('cancellation: abortSignal is threaded into spawnWithRetry so the AI subprocess receives SIGTERM', async () => {
    const task = makeTask();
    // Spawn awaits the abort — emulates a real Claude child that is still
    // running when the user cancels. The scheduler's cancellation path must
    // deliver the signal all the way through to this call.
    const spawnImpl = (_taskId: string, _count: number, opts?: { abortSignal?: AbortSignal }) =>
      new Promise<SessionResult>((resolve, reject) => {
        const sig = opts?.abortSignal;
        if (!sig) {
          reject(new Error('expected abortSignal to be threaded to the provider spawn'));
          return;
        }
        if (sig.aborted) {
          reject(new SpawnError('Aborted by caller', '', 1));
          return;
        }
        sig.addEventListener('abort', () => {
          reject(new SpawnError('Aborted by caller', '', 1));
        });
      });

    const scenario = buildDeps({ tasks: [task] });
    // Swap the default spawn impl for one that captures + observes options.
    scenario.spawnWithRetry.mockReset();
    const spawnMockImpl: (prompt: string, opts: { abortSignal?: AbortSignal }) => Promise<SessionResult> = (
      prompt,
      opts
    ) => {
      void prompt;
      return spawnImpl('t1', 1, { abortSignal: opts.abortSignal });
    };
    scenario.spawnWithRetry.mockImplementation(spawnMockImpl as never);

    const ac = new AbortController();
    setTimeout(() => {
      ac.abort();
    }, 20);

    const pipeline = createExecuteSprintPipeline(scenario.deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1', abortSignal: ac.signal });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // spawnWithRetry must have been called with the abortSignal (not undefined).
    const calls = scenario.spawnWithRetry.mock.calls as [unknown, { abortSignal?: AbortSignal }][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[1]?.abortSignal).toBe(ac.signal);
    // Summary reflects cancellation, not a generic task_blocked.
    expect(result.value.context.executionSummary?.stopReason).toBe('cancelled');
  });

  it('cancellation drain: in-progress tasks this run launched are flipped to cancelled', async () => {
    const task = makeTask();
    let saveCalledWith: Task[] | null = null;
    const abortFromSpawn = new AbortController();

    // Observe when spawn fires, then abort. The spawn then throws SpawnError
    // (non-rate-limit) which executeOneTask converts to success:false →
    // execute-task returns ParseError → pipeline stops without reaching
    // mark-done. The task is left `in_progress` in persistence.
    const spawnImpl = (_taskId: string, _count: number, opts?: { abortSignal?: AbortSignal }) =>
      new Promise<SessionResult>((_resolve, reject) => {
        const sig = opts?.abortSignal;
        abortFromSpawn.abort(); // tell the outer test to abort
        if (sig?.aborted) {
          reject(new SpawnError('Aborted by caller', '', 1));
          return;
        }
        sig?.addEventListener('abort', () => {
          reject(new SpawnError('Aborted by caller', '', 1));
        });
      });

    const scenario = buildDeps({ tasks: [task] });
    scenario.spawnWithRetry.mockReset();
    const spawnMockImpl: (prompt: string, opts: { abortSignal?: AbortSignal }) => Promise<SessionResult> = (
      prompt,
      opts
    ) => {
      void prompt;
      return spawnImpl('t1', 1, { abortSignal: opts.abortSignal });
    };
    scenario.spawnWithRetry.mockImplementation(spawnMockImpl as never);

    // Intercept saveTasks so we can verify the drain's write. The test
    // persistence stub doesn't expose saveTasks by default — install one
    // that mirrors writes into stateTasks so getTasks() sees them.
    const persistenceWithSave = scenario.deps.persistence as unknown as {
      saveTasks: PersistencePort['saveTasks'];
    };
    persistenceWithSave.saveTasks = vi.fn((next: Task[]) => {
      saveCalledWith = next.map((t) => ({ ...t }));
      for (const t of next) {
        const target = scenario.stateTasks.find((s) => s.id === t.id);
        if (target) target.status = t.status;
      }
      return Promise.resolve();
    });

    const ac = new AbortController();
    abortFromSpawn.signal.addEventListener('abort', () => {
      ac.abort();
    });

    const pipeline = createExecuteSprintPipeline(scenario.deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1', abortSignal: ac.signal });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Summary is cancelled.
    expect(result.value.context.executionSummary?.stopReason).toBe('cancelled');

    // The drain called saveTasks with the task flipped to cancelled.
    expect(saveCalledWith).not.toBeNull();
    const saved = saveCalledWith as unknown as Task[];
    const updatedTask = saved.find((t) => t.id === 't1');
    expect(updatedTask?.status).toBe('cancelled');

    // task-finished event fired with status=cancelled (dashboard signal).
    const cancelled = scenario.events.find((e) => e.type === 'task-finished' && e.status === 'cancelled');
    expect(cancelled).toBeDefined();
  });

  it('cancellation drain: skipped entirely when this run never launched anything', async () => {
    // Empty task list — nothing to launch. `pullItems` is called once, the
    // test aborts before the first settle, and the scheduler exits with
    // `stats.cancelled=true`. The drain sees an empty `launchedTaskIds`
    // and must NOT saveTasks — otherwise a cancelled-but-launched-nothing
    // run would spuriously write the tasks file.
    const scenario = buildDeps({
      tasks: [],
      sprint: makeSprint({ tickets: [makeTicket({ affectedRepoIds: ['repo-a'] })] }),
    });

    let saveCalled = false;
    (scenario.deps.persistence as unknown as { saveTasks: PersistencePort['saveTasks'] }).saveTasks = vi.fn(() => {
      saveCalled = true;
      return Promise.resolve();
    });

    const ac = new AbortController();
    // Pipeline short-circuits in prepare-tasks (empty) and execute-tasks
    // no-ops. Abort is an extra guard — the drain only runs when the
    // scheduler reports cancelled, which requires the scheduler to run.
    // For the empty-tasks path, that step is skipped, so the drain never
    // runs and the assertion is that saveTasks is never called.

    const pipeline = createExecuteSprintPipeline(scenario.deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1', abortSignal: ac.signal });

    expect(result.ok).toBe(true);
    // No tasks in the sprint → no launches, no drain write.
    expect(saveCalled).toBe(false);
    // Empty tasks short-circuits with stopReason: 'no_tasks'.
    if (!result.ok) return;
    expect(result.value.context.executionSummary?.stopReason).toBe('no_tasks');
  });

  it('fail-fast drains in-flight tasks before failing', async () => {
    const taskA = makeTask({ id: 't1', order: 1, repoId: 'repo-a' });
    const taskB = makeTask({ id: 't2', order: 2, repoId: 'repo-b' });

    // Task A fails fast (its spawn resolves with success:false via a
    // `<task-blocked>` signal); task B runs long enough that it's still
    // in-flight when A settles. With failFast (default), the scheduler
    // should wait for B to finish before returning.
    let bCompleted = false;
    let aSettled = false;
    const spawnImpl = async (taskId: string): Promise<SessionResult> => {
      if (taskId === 't1') {
        aSettled = true;
        return {
          output: '<task-blocked>needs input</task-blocked>',
          sessionId: 'sess',
          model: 'claude-sonnet',
        };
      }
      // Task B — keep running after A has settled so fail-fast has
      // something to drain.
      await new Promise((r) => setTimeout(r, 30));
      bCompleted = true;
      return { output: '<task-complete/>', sessionId: 'sess', model: 'claude-sonnet' };
    };
    const { deps } = buildDeps({
      tasks: [taskA, taskB],
      sprint: makeSprint({
        tickets: [makeTicket({ affectedRepoIds: ['repo-a', 'repo-b'] })],
      }),
      spawnImpl,
    });

    const pipeline = createExecuteSprintPipeline(deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(aSettled).toBe(true);
    // Task B ran to completion before the scheduler returned (fail-fast
    // drain semantics).
    expect(bCompleted).toBe(true);
    expect(result.value.context.executionSummary?.stopReason).toBe('task_blocked');
  });

  // -------------------------------------------------------------------------
  // Evaluator non-blocking fence — the architectural assertion that a failing
  // evaluation does NOT short-circuit the per-task pipeline. The task still
  // reaches `mark-done`, the sprint still finishes `all_completed`, and the
  // full critique lives in the evaluation sidecar for post-hoc review.
  //
  // The evaluator is advisory: its job is to surface concerns, not to stall
  // forward progress. Blocking behaviour would be a regression of this
  // design choice.
  // -------------------------------------------------------------------------
  it('failed evaluation does NOT block mark-done — sprint proceeds to completion', async () => {
    const task = makeTask();
    // Generator emits <task-complete> as usual; the evaluator spawn (same
    // spawnWithRetry) is differentiated by the prompt content. The
    // parseEvaluation stub always returns `failed`, simulating a persistent
    // evaluator rejection. Iterations=1 so the loop exits quickly.
    const scenario = buildDeps({
      tasks: [task],
      config: makeConfig({ evaluationIterations: 1 }),
      spawnImpl: (): Promise<SessionResult> =>
        Promise.resolve({
          output: '<task-complete/>',
          sessionId: 'sess',
          model: 'claude-sonnet',
        } as SessionResult),
    });

    // Swap in evaluator-aware parser + prompt builder. Prompt-builder gains
    // `buildTaskEvaluationPrompt`; parser gains `parseEvaluation` returning
    // failed. parseExecutionSignals from the default stub already handles
    // the generator's `<task-complete/>`.
    (
      scenario.deps as unknown as {
        promptBuilder: { buildTaskEvaluationPrompt: () => string; buildTaskExecutionPrompt?: () => string };
      }
    ).promptBuilder.buildTaskEvaluationPrompt = () => 'evaluator prompt';
    (scenario.deps as unknown as { parser: OutputParserPort & { parseEvaluation?: unknown } }).parser.parseEvaluation =
      (output: string) => ({
        status: 'failed' as const,
        dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: `bad: ${output}` }],
        rawOutput: output,
      });
    // Persistence needs writeEvaluation for sidecar writes.
    (scenario.deps.persistence as unknown as { writeEvaluation: () => Promise<void> }).writeEvaluation = vi.fn(() =>
      Promise.resolve()
    );

    const pipeline = createExecuteSprintPipeline(scenario.deps, { noFeedback: true });
    const result = await executePipeline(pipeline, { sprintId: 's1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Task MUST be marked done — the evaluator's failure was advisory only.
    const persistedTask = scenario.stateTasks.find((t) => t.id === 't1');
    expect(persistedTask?.status).toBe('done');

    // The sprint ran through all tasks successfully.
    expect(result.value.context.executionSummary?.stopReason).toBe('all_completed');

    // updateTaskStatus was called with 'in_progress' AND 'done' — the
    // full happy-path trace. The evaluator did not stall mark-done.
    const statusCalls = (scenario.calls.updateTaskStatus.mock.calls as [string, string, string][]).map((c) => c[1]);
    expect(statusCalls).toContain('in_progress');
    expect(statusCalls).toContain('done');
  });
});
