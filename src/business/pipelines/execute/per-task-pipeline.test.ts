import { describe, expect, it, vi } from 'vitest';
import type { Config, Sprint, Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { HarnessEvent } from '@src/business/ports/signal-bus.ts';
import type { ExecuteTasksUseCase, TaskExecutionResult } from '@src/business/usecases/execute.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { createPerTaskPipeline, type PerTaskDeps } from './per-task-pipeline.ts';
import type { PerTaskContext } from './per-task-context.ts';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    name: 'Sprint',
    projectId: 'proj-1',
    status: 'active',
    createdAt: '',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Task 1',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
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
    evaluationIterations: 1,
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

function emptyStub(): never {
  return {} as never;
}

interface Scenario {
  task?: Task;
  sprint?: Sprint;
  verifyBranch?: ExternalPort['verifyBranch'];
  executeResult?: TaskExecutionResult;
  postCheckPassed?: boolean;
  evaluationEnabled?: boolean;
  evaluatorShouldFail?: boolean;
}

/** Build deps + a fake use case with sensible defaults for a happy path. */
function setup(scenario: Scenario = {}): {
  deps: PerTaskDeps;
  useCase: ExecuteTasksUseCase;
  events: HarnessEvent[];
  calls: {
    executeOneTask: ReturnType<typeof vi.fn>;
    runPostTaskCheck: ReturnType<typeof vi.fn>;
    updateTaskStatus: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
    logProgress: ReturnType<typeof vi.fn>;
    verifyBranch: ReturnType<typeof vi.fn>;
  };
} {
  const events: HarnessEvent[] = [];

  const task = scenario.task ?? makeTask();
  const sprint = scenario.sprint ?? makeSprint();

  const executeResult: TaskExecutionResult = scenario.executeResult ?? {
    taskId: task.id,
    success: true,
    output: 'ok',
    verified: true,
    verificationOutput: 'verified',
    model: 'claude-sonnet',
  };
  const postCheckPassed = scenario.postCheckPassed ?? true;

  const executeOneTask = vi.fn(() => Promise.resolve(executeResult));
  const runPostTaskCheck = vi.fn(() => Promise.resolve(postCheckPassed));
  const updateTaskStatus = vi.fn(() => Promise.resolve(task));
  const updateTask = vi.fn(() => Promise.resolve());
  const logProgress = vi.fn(() => Promise.resolve());
  const verifyBranch = vi.fn(scenario.verifyBranch ?? (() => true));

  const getEvaluationConfig = vi.fn(() =>
    Promise.resolve({
      enabled: scenario.evaluationEnabled ?? false,
      iterations: scenario.evaluationEnabled ? 1 : 0,
    })
  );

  const useCase = {
    executeOneTask,
    runPostTaskCheck,
    getEvaluationConfig,
  } as unknown as ExecuteTasksUseCase;

  // When evaluator is enabled, stub enough of the graph that the nested
  // pipeline runs to completion or fails gracefully per the scenario.
  const getSprint = scenario.evaluatorShouldFail
    ? () => Promise.reject(new Error('boom'))
    : () => Promise.resolve(sprint);

  const persistence = {
    updateTaskStatus,
    updateTask,
    logProgress,
    getSprint,
    getTask: () => Promise.resolve(task),
    getConfig: () => Promise.resolve(makeConfig(scenario.evaluationEnabled ? {} : { evaluationIterations: 0 })),
    getTasks: () => Promise.resolve([task]),
    saveTasks: () => Promise.resolve(),
    writeEvaluation: () => Promise.resolve(),
    // contract-negotiate / branch-preflight / mark-done look up repo info.
    // branch-preflight + mark-done need resolveRepoPath; contract-negotiate
    // falls back to "no check script configured" cleanly when lookup throws.
    getProject: () => Promise.reject(new Error('not configured in test')),
    getRepoById: () => Promise.reject(new Error('not configured in test')),
    resolveRepoPath: () => Promise.resolve('/repo'),
  } as unknown as PersistencePort;

  const aiSession = {
    ensureReady: () => Promise.resolve(),
    getProviderName: () => 'claude',
    getSpawnEnv: () => ({}),
    spawnWithRetry: () =>
      Promise.resolve({
        output: '<evaluation-passed>ok</evaluation-passed>',
        sessionId: 's',
      }),
  } as unknown as AiSessionPort;

  const promptBuilder = {
    buildTaskEvaluationPrompt: () => 'prompt',
  } as unknown as PromptBuilderPort;

  const parser = {
    parseEvaluation: () => ({ status: 'passed', dimensions: [], rawOutput: 'ok' }),
  } as unknown as OutputParserPort;

  const external = {
    verifyBranch,
    // Evaluator renders a Project Tooling section from detectProjectTooling();
    // tests don't care about the content, just that it's a string.
    detectProjectTooling: () => '',
    // recover-dirty-tree fence: default clean so the happy path skips the
    // auto-commit branch entirely.
    hasUncommittedChanges: () => false,
    autoCommit: () => Promise.resolve(),
  } as unknown as ExternalPort;

  const deps: PerTaskDeps = {
    persistence,
    fs: {
      getSprintDir: () => '/tmp',
      ensureDir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
    } as unknown as FilesystemPort,
    aiSession,
    promptBuilder,
    parser,
    ui: emptyStub(),
    logger: makeLogger(),
    external,
    signalBus: {
      emit: (e) => events.push(e),
      subscribe: () => () => undefined,
      dispose: () => undefined,
    },
  };

  return {
    deps,
    useCase,
    events,
    calls: {
      executeOneTask,
      runPostTaskCheck,
      updateTaskStatus,
      updateTask,
      logProgress,
      verifyBranch,
    },
  };
}

function makeCtx(deps: PerTaskDeps, task: Task, sprint: Sprint): PerTaskContext {
  void deps;
  return { sprintId: sprint.id, sprint, task };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPerTaskPipeline', () => {
  it('happy path: runs all 9 steps in order', async () => {
    const task = makeTask();
    const sprint = makeSprint();
    const { deps, useCase, events, calls } = setup({ task, sprint });

    const pipeline = createPerTaskPipeline(deps, useCase);
    const result = await executePipeline(pipeline, makeCtx(deps, task, sprint));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.stepResults.map((r) => r.stepName);
    expect(stepNames).toEqual([
      'branch-preflight',
      'contract-negotiate',
      'mark-in-progress',
      'execute-task',
      'store-verification',
      'post-task-check',
      'evaluate-task',
      'recover-dirty-tree',
      'mark-done',
    ]);

    // signal bus emits task-started (from mark-in-progress) and task-finished
    // (from mark-done), interleaved with per-step task-step trace events.
    // Ignore the step-trace events here; their ordering is covered separately.
    const lifecycleTypes = events.map((e) => e.type).filter((t) => t !== 'task-step');
    expect(lifecycleTypes).toEqual(['task-started', 'task-finished']);

    expect(calls.executeOneTask).toHaveBeenCalledTimes(1);
    expect(calls.runPostTaskCheck).toHaveBeenCalledTimes(1);
    expect(calls.updateTaskStatus).toHaveBeenCalledTimes(2); // in_progress + done
    expect(calls.updateTask).toHaveBeenCalledTimes(1); // verification
    expect(calls.logProgress).toHaveBeenCalledTimes(1);
  });

  it('stops at branch-preflight when sprint branch is wrong', async () => {
    const task = makeTask();
    const sprint = makeSprint({ branch: 'feature/x' });
    const { deps, useCase, calls } = setup({ task, sprint, verifyBranch: () => false });

    const pipeline = createPerTaskPipeline(deps, useCase);
    const result = await executePipeline(pipeline, makeCtx(deps, task, sprint));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // executeOneTask and downstream must not have been called.
    expect(calls.executeOneTask).not.toHaveBeenCalled();
    expect(calls.runPostTaskCheck).not.toHaveBeenCalled();
  });

  it('stops at execute-task when the task is blocked', async () => {
    const task = makeTask();
    const sprint = makeSprint();
    const { deps, useCase, calls } = setup({
      task,
      sprint,
      executeResult: { taskId: task.id, success: false, output: '', blocked: 'missing input' },
    });

    const pipeline = createPerTaskPipeline(deps, useCase);
    const result = await executePipeline(pipeline, makeCtx(deps, task, sprint));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(calls.runPostTaskCheck).not.toHaveBeenCalled();
    // Task stays in_progress — mark-done never ran, no task-finished emitted.
    expect(calls.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(calls.updateTaskStatus).toHaveBeenCalledWith(task.id, 'in_progress', sprint.id);
  });

  it('stops at post-task-check when the gate fails', async () => {
    const task = makeTask();
    const sprint = makeSprint();
    const { deps, useCase, calls } = setup({ task, sprint, postCheckPassed: false });

    const pipeline = createPerTaskPipeline(deps, useCase);
    const result = await executePipeline(pipeline, makeCtx(deps, task, sprint));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(calls.runPostTaskCheck).toHaveBeenCalledTimes(1);
    // mark-done never ran.
    expect(calls.logProgress).not.toHaveBeenCalled();
  });

  it('evaluator disabled: evaluate-task records as success and pipeline completes', async () => {
    const task = makeTask();
    const sprint = makeSprint();
    const { deps, useCase } = setup({ task, sprint, evaluationEnabled: false });

    const pipeline = createPerTaskPipeline(deps, useCase);
    const result = await executePipeline(pipeline, makeCtx(deps, task, sprint));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const evalStep = result.value.stepResults.find((r) => r.stepName === 'evaluate-task');
    expect(evalStep?.status).toBe('success');
    expect(result.value.context.evaluationStepNames).toBeUndefined();
  });

  it('evaluator enabled happy path: inner evaluator step names are recorded', async () => {
    const task = makeTask();
    const sprint = makeSprint();
    const { deps, useCase } = setup({ task, sprint, evaluationEnabled: true });

    const pipeline = createPerTaskPipeline(deps, useCase);
    const result = await executePipeline(pipeline, makeCtx(deps, task, sprint));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.context.evaluationStepNames).toEqual([
      'load-sprint',
      'load-task',
      'check-already-evaluated',
      'run-evaluator-loop',
    ]);
  });

  it('evaluator failure does not block mark-done (evaluator is advisory)', async () => {
    const task = makeTask();
    const sprint = makeSprint();
    const { deps, useCase, calls } = setup({
      task,
      sprint,
      evaluationEnabled: true,
      evaluatorShouldFail: true,
    });

    const pipeline = createPerTaskPipeline(deps, useCase);
    const result = await executePipeline(pipeline, makeCtx(deps, task, sprint));

    expect(result.ok).toBe(true);
    // mark-done still ran even though the evaluator inner pipeline errored.
    expect(calls.logProgress).toHaveBeenCalledTimes(1);
    expect(calls.updateTaskStatus).toHaveBeenCalledWith(task.id, 'done', sprint.id);
  });
});
