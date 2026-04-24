import { describe, expect, it } from 'vitest';
import type { Config, Sprint, Task } from '@src/domain/models.ts';
import { StepError, TaskNotFoundError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { createEvaluatorPipeline, type EvaluateContext, type EvaluateDeps } from './evaluate.ts';

// ---------------------------------------------------------------------------
// Minimal in-memory stubs
// ---------------------------------------------------------------------------

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'test-sprint',
    name: 'Test Sprint',
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Test task',
    steps: [],
    verificationCriteria: [],
    status: 'done',
    order: 1,
    blockedBy: [],
    repoId: 'repo-1',
    verified: true,
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
  return {
    succeed: () => {
      /* noop */
    },
    fail: () => {
      /* noop */
    },
    stop: () => {
      /* noop */
    },
  };
}

function makeLogger(): LoggerPort {
  const logger: LoggerPort = {
    debug: () => {
      /* noop */
    },
    info: () => {
      /* noop */
    },
    warn: () => {
      /* noop */
    },
    error: () => {
      /* noop */
    },
    success: () => {
      /* noop */
    },
    warning: () => {
      /* noop */
    },
    tip: () => {
      /* noop */
    },
    header: () => {
      /* noop */
    },
    separator: () => {
      /* noop */
    },
    field: () => {
      /* noop */
    },
    card: () => {
      /* noop */
    },
    newline: () => {
      /* noop */
    },
    dim: () => {
      /* noop */
    },
    item: () => {
      /* noop */
    },
    spinner: () => makeSpinner(),
    child: () => logger,
    time: () => () => {
      /* noop */
    },
  };
  return logger;
}

function makePersistence(overrides: Partial<PersistencePort> = {}): PersistencePort {
  const stubbed = {
    resolveRepoPath: () => Promise.resolve('/tmp/repo'),
    getRepoById: () => Promise.reject(new Error('not configured in test')),
  } as unknown as PersistencePort;
  overrides = { ...stubbed, ...overrides };
  const stub = {} as PersistencePort;
  return { ...stub, ...overrides };
}

function makeFs(overrides: Partial<FilesystemPort> = {}): FilesystemPort {
  const stub = {} as FilesystemPort;
  return { ...stub, ...overrides };
}

function makeAiSession(overrides: Partial<AiSessionPort> = {}): AiSessionPort {
  const stub = {
    ensureReady: () => Promise.resolve(),
  } as unknown as AiSessionPort;
  return { ...stub, ...overrides };
}

function makePromptBuilder(overrides: Partial<PromptBuilderPort> = {}): PromptBuilderPort {
  const stub = {} as PromptBuilderPort;
  return { ...stub, ...overrides };
}

function makeParser(overrides: Partial<OutputParserPort> = {}): OutputParserPort {
  const stub = {} as OutputParserPort;
  return { ...stub, ...overrides };
}

function makeUi(overrides: Partial<UserInteractionPort> = {}): UserInteractionPort {
  const stub = {} as UserInteractionPort;
  return { ...stub, ...overrides };
}

function makeExternal(overrides: Partial<ExternalPort> = {}): ExternalPort {
  const stub = {
    detectProjectTooling: () => '',
  } as unknown as ExternalPort;
  return { ...stub, ...overrides };
}

function makeDeps(overrides: Partial<EvaluateDeps> = {}): EvaluateDeps {
  return {
    persistence: makePersistence(),
    fs: makeFs(),
    aiSession: makeAiSession(),
    promptBuilder: makePromptBuilder(),
    parser: makeParser(),
    ui: makeUi(),
    logger: makeLogger(),
    external: makeExternal(),
    ...overrides,
  };
}

/**
 * Initial context the pipeline always starts with. Task-specific
 * evaluator inputs (fallbackModel, generatorSessionId) flow via options
 * on the pipeline factory, not through context.
 */
function makeInitialContext(overrides: Partial<EvaluateContext> = {}): EvaluateContext {
  return {
    sprintId: 'test-sprint',
    taskId: 'task-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEvaluatorPipeline', () => {
  it('happy path: runs all four steps in order and records summary', async () => {
    const sprint = makeSprint();
    const task = makeTask({ evaluated: false });

    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        getTask: () => Promise.resolve(task),
        getConfig: () => Promise.resolve(makeConfig()),
        getTasks: () => Promise.resolve([task]),
        saveTasks: () => Promise.resolve(),
        updateTask: () => Promise.resolve(),
        writeEvaluation: () => Promise.resolve(),
      }),
      fs: makeFs({
        getSprintDir: () => '/tmp/sprint',
      }),
      aiSession: makeAiSession({
        getProviderName: () => 'claude',
        getSpawnEnv: () => ({}),
        spawnWithRetry: () =>
          Promise.resolve({
            output: '<evaluation-passed>all good</evaluation-passed>',
            sessionId: 'evaluator-session',
          }),
      }),
      promptBuilder: makePromptBuilder({
        buildTaskEvaluationPrompt: () => 'evaluator prompt',
      }),
      parser: makeParser({
        parseEvaluation: () => ({
          status: 'passed',
          dimensions: [],
          rawOutput: 'all good',
        }),
      }),
    });

    const pipeline = createEvaluatorPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.stepResults.map((r) => r.stepName);
    expect(stepNames).toEqual(['load-sprint', 'load-task', 'check-already-evaluated', 'run-evaluator-loop']);

    const summary = result.value.context.evaluationSummary;
    expect(summary).toBeDefined();
    expect(summary?.taskId).toBe('task-1');
    expect(summary?.status).toBe('passed');
    expect(summary?.iterations).toBe(1);
  });

  it('missing sprint fails at load-sprint and does not advance', async () => {
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.reject(new Error('no such sprint')),
      }),
    });

    const pipeline = createEvaluatorPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext({ sprintId: 'missing' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).stepName).toBe('load-sprint');
  });

  it('missing task fails at load-task with TaskNotFoundError', async () => {
    const sprint = makeSprint();
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        getTask: () => Promise.reject(new Error('no such task')),
      }),
    });

    const pipeline = createEvaluatorPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext({ taskId: 'missing-task' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const err = result.error;
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).stepName).toBe('load-task');
    expect((err as StepError).cause).toBeInstanceOf(TaskNotFoundError);
  });

  it('already-evaluated task: check-already-evaluated writes skipped summary and run-evaluator-loop no-ops', async () => {
    const sprint = makeSprint();
    const task = makeTask({ evaluated: true, evaluationStatus: 'passed' });

    // If the loop ran, it would need these stubs. Leave them unset so a
    // regression surfaces as a thrown error rather than a silent skip.
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        getTask: () => Promise.resolve(task),
      }),
    });

    const pipeline = createEvaluatorPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.stepResults.map((r) => r.stepName);
    expect(stepNames).toEqual(['load-sprint', 'load-task', 'check-already-evaluated', 'run-evaluator-loop']);

    const summary = result.value.context.evaluationSummary;
    expect(summary).toEqual({ taskId: 'task-1', status: 'skipped', iterations: 0 });
  });

  it('force=true re-evaluates even when task.evaluated is true', async () => {
    const sprint = makeSprint();
    const task = makeTask({ evaluated: true, evaluationStatus: 'failed' });

    let evaluatorSpawned = false;
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        getTask: () => Promise.resolve(task),
        getConfig: () => Promise.resolve(makeConfig()),
        getTasks: () => Promise.resolve([task]),
        saveTasks: () => Promise.resolve(),
        updateTask: () => Promise.resolve(),
        writeEvaluation: () => Promise.resolve(),
      }),
      fs: makeFs({
        getSprintDir: () => '/tmp/sprint',
      }),
      aiSession: makeAiSession({
        getProviderName: () => 'claude',
        getSpawnEnv: () => ({}),
        spawnWithRetry: () => {
          evaluatorSpawned = true;
          return Promise.resolve({
            output: '<evaluation-passed>fixed</evaluation-passed>',
            sessionId: 'evaluator-session',
          });
        },
      }),
      promptBuilder: makePromptBuilder({
        buildTaskEvaluationPrompt: () => 'evaluator prompt',
      }),
      parser: makeParser({
        parseEvaluation: () => ({
          status: 'passed',
          dimensions: [],
          rawOutput: 'fixed',
        }),
      }),
    });

    const pipeline = createEvaluatorPipeline(deps, { force: true });
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(evaluatorSpawned).toBe(true);
    const summary = result.value.context.evaluationSummary;
    expect(summary?.status).toBe('passed');
    expect(summary?.iterations).toBe(1);
  });

  it('plateau: short-circuits when the evaluator flags the same failed dimensions twice', async () => {
    const sprint = makeSprint();
    const task = makeTask({ evaluated: false });

    // Each evaluator spawn returns the same failed dimensions (just reworded).
    // Fix attempt signals completion so the loop advances to re-evaluation.
    const spawnOutputs = [
      '<evaluation-failed>missing null check in handler</evaluation-failed>',
      '<task-complete/>', // resume generator
      '<evaluation-failed>null dereference in handler</evaluation-failed>',
    ];
    let spawnCall = 0;
    const parseCalls: number[] = [];
    let saveTasksCalledWith: string | undefined;
    const writeEvalCalls: { iteration: number; status: string }[] = [];

    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        getTask: () => Promise.resolve(task),
        getConfig: () => Promise.resolve(makeConfig({ evaluationIterations: 3 })),
        getTasks: () => Promise.resolve([task]),
        saveTasks: () => Promise.resolve(),
        updateTask: (_taskId, updates) => {
          saveTasksCalledWith = updates.evaluationStatus;
          return Promise.resolve();
        },
        writeEvaluation: (_sprintId, _taskId, iteration, status) => {
          writeEvalCalls.push({ iteration, status });
          return Promise.resolve();
        },
      }),
      fs: makeFs({
        getSprintDir: () => '/tmp/sprint',
      }),
      aiSession: makeAiSession({
        getProviderName: () => 'claude',
        getSpawnEnv: () => ({}),
        spawnWithRetry: () => {
          const output = spawnOutputs[spawnCall] ?? '';
          spawnCall++;
          return Promise.resolve({ output, sessionId: 'evaluator' });
        },
      }),
      promptBuilder: makePromptBuilder({
        buildTaskEvaluationPrompt: () => 'evaluator prompt',
        buildTaskEvaluationResumePrompt: () => 'resume prompt',
      }),
      parser: makeParser({
        parseEvaluation: (output: string) => {
          parseCalls.push(parseCalls.length + 1);
          return {
            status: 'failed',
            dimensions: [{ dimension: 'Correctness', status: 'FAIL', description: output }],
            rawOutput: output,
          };
        },
        parseExecutionSignals: () => ({ complete: true, blocked: null, verified: null }),
      }),
    });

    const pipeline = createEvaluatorPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = result.value.context.evaluationSummary;
    expect(summary?.status).toBe('plateau');
    // Iteration 1 (initial) + iteration 2 (re-eval after fix) = 2 evaluator spawns.
    expect(summary?.iterations).toBe(2);
    expect(spawnCall).toBe(3); // 2 eval spawns + 1 fix-attempt spawn
    // The persisted task status mirrors the plateau.
    expect(saveTasksCalledWith).toBe('plateau');
    // Sidecar records plateau on iteration 2 (the repeat detection).
    expect(writeEvalCalls).toContainEqual({ iteration: 2, status: 'plateau' });
  });

  it('iterations=0 yields skipped summary without evaluator spawn', async () => {
    const sprint = makeSprint();
    const task = makeTask({ evaluated: false });

    let evaluatorSpawned = false;
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        getTask: () => Promise.resolve(task),
        getConfig: () => Promise.resolve(makeConfig({ evaluationIterations: 0 })),
      }),
      aiSession: makeAiSession({
        getProviderName: () => 'claude',
        getSpawnEnv: () => ({}),
        spawnWithRetry: () => {
          evaluatorSpawned = true;
          return Promise.resolve({ output: '', sessionId: 'never' });
        },
      }),
    });

    // Pass iterations: 0 explicitly so the use case's internal skip fires.
    const pipeline = createEvaluatorPipeline(deps, { iterations: 0 });
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(evaluatorSpawned).toBe(false);
    const summary = result.value.context.evaluationSummary;
    expect(summary).toEqual({ taskId: 'task-1', status: 'skipped', iterations: 0 });
  });
});
