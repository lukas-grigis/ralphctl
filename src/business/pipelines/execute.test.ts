import { describe, expect, it } from 'vitest';
import type { Config, Sprint, Task, Ticket } from '@src/domain/models.ts';
import { SprintNotFoundError, StepError, StorageError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus.ts';
import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { createExecuteSprintPipeline, type ExecuteContext, type ExecuteDeps } from './execute.ts';

// ---------------------------------------------------------------------------
// Stub factories
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

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket-1',
    title: 'Test Ticket',
    requirementStatus: 'approved',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Test task',
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
  const stub = {} as ExternalPort;
  return { ...stub, ...overrides };
}

function makeSignalParser(overrides: Partial<SignalParserPort> = {}): SignalParserPort {
  const stub = {} as SignalParserPort;
  return { ...stub, ...overrides };
}

function makeSignalHandler(overrides: Partial<SignalHandlerPort> = {}): SignalHandlerPort {
  const stub = {} as SignalHandlerPort;
  return { ...stub, ...overrides };
}

function makeSignalBus(overrides: Partial<SignalBusPort> = {}): SignalBusPort {
  const stub = {
    emit: () => {
      /* noop */
    },
    subscribe: () => () => {
      /* noop */
    },
    dispose: () => {
      /* noop */
    },
  } as SignalBusPort;
  return { ...stub, ...overrides };
}

function makeCoordinator(): RateLimitCoordinatorPort {
  // Stub: these tests don't exercise rate-limit semantics. The executor
  // integration test uses the real coordinator.
  return {
    isPaused: false,
    remainingMs: 0,
    pause: () => void 0,
    waitIfPaused: () => Promise.resolve(),
    dispose: () => void 0,
  };
}

function makeDeps(overrides: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    persistence: makePersistence(),
    fs: makeFs(),
    aiSession: makeAiSession(),
    promptBuilder: makePromptBuilder(),
    parser: makeParser(),
    ui: makeUi(),
    logger: makeLogger(),
    external: makeExternal(),
    signalParser: makeSignalParser(),
    signalHandler: makeSignalHandler(),
    signalBus: makeSignalBus(),
    createRateLimitCoordinator: makeCoordinator,
    processLifecycle: {
      ensureHandlers: () => void 0,
      isShuttingDown: () => false,
    },
    ...overrides,
  };
}

function makeInitialContext(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    sprintId: 'test-sprint',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExecuteSprintPipeline', () => {
  it('happy path (active sprint, zero tasks): short-circuits with no_tasks summary', async () => {
    const sprint = makeSprint({ status: 'active' });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        reorderByDependencies: () => Promise.resolve(),
        getTasks: () => Promise.resolve([]),
        getConfig: () => Promise.resolve(makeConfig()),
      }),
      ui: makeUi({
        // resolve-branch prompts when sprint.branch is null and no flag is set
        selectBranchStrategy: () => Promise.resolve(null),
      }),
      external: makeExternal({
        generateBranchName: () => 'ralphctl/test-sprint',
      }),
    });

    const pipeline = createExecuteSprintPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All steps run — each downstream step no-ops because tasksEmpty is set.
    const stepNames = result.value.stepResults.map((r) => r.stepName);
    expect(stepNames).toEqual([
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

    const summary = result.value.context.executionSummary;
    expect(summary).toEqual({
      completed: 0,
      remaining: 0,
      blocked: 0,
      stopReason: 'no_tasks',
      exitCode: 2,
    });
  });

  it('draft sprint declined at precondition: terminates with user_paused summary', async () => {
    const sprint = makeSprint({
      status: 'draft',
      tickets: [makeTicket({ requirementStatus: 'pending' })],
    });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
      ui: makeUi({
        confirm: () => Promise.resolve(false), // decline the prompt
      }),
    });

    const pipeline = createExecuteSprintPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All steps run (they no-op after precondition decline) but the summary
    // is set by check-preconditions.
    const stepNames = result.value.stepResults.map((r) => r.stepName);
    expect(stepNames[0]).toBe('load-sprint');
    expect(stepNames[1]).toBe('check-preconditions');

    const summary = result.value.context.executionSummary;
    expect(summary).toEqual({
      completed: 0,
      remaining: 0,
      blocked: 0,
      stopReason: 'user_paused',
      exitCode: 0,
    });
  });

  it('sprint not found: fails at load-sprint and does not advance', async () => {
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.reject(new Error('no such sprint')),
      }),
    });

    const pipeline = createExecuteSprintPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext({ sprintId: 'missing' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).stepName).toBe('load-sprint');
    expect((result.error as StepError).cause).toBeInstanceOf(SprintNotFoundError);
  });

  it('invalid branch name: ensure-branches fails with StorageError', async () => {
    const sprint = makeSprint({ status: 'active' });
    const task = makeTask();
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        reorderByDependencies: () => Promise.resolve(),
        getTasks: () => Promise.resolve([task]),
      }),
      external: makeExternal({
        isValidBranchName: () => false, // reject branch name
      }),
    });

    const pipeline = createExecuteSprintPipeline(deps, { branchName: 'bad branch name' });
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).stepName).toBe('ensure-branches');
    expect((result.error as StepError).cause).toBeInstanceOf(StorageError);
  });

  it('auto-activates a draft sprint with --force', async () => {
    const draftSprint = makeSprint({ status: 'draft' });
    const activatedSprint = makeSprint({ status: 'active' });

    let activated = false;
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(draftSprint),
        reorderByDependencies: () => Promise.resolve(),
        getTasks: () => Promise.resolve([]),
        activateSprint: () => {
          activated = true;
          return Promise.resolve(activatedSprint);
        },
      }),
      ui: makeUi({
        selectBranchStrategy: () => Promise.resolve(null),
      }),
      external: makeExternal({
        generateBranchName: () => 'ralphctl/test-sprint',
      }),
    });

    const pipeline = createExecuteSprintPipeline(deps, { force: true });
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(activated).toBe(true);
    expect(result.value.context.sprint?.status).toBe('active');
  });

  it('closed sprint fails at assert-active with SprintStatusError', async () => {
    const sprint = makeSprint({ status: 'closed' });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
      ui: makeUi({
        selectBranchStrategy: () => Promise.resolve(null),
      }),
      external: makeExternal({
        generateBranchName: () => 'ralphctl/test-sprint',
      }),
    });

    const pipeline = createExecuteSprintPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).stepName).toBe('assert-active');
  });

  it('resolve-branch uses sprint.branch when already persisted (no prompt, no generate)', async () => {
    const sprint = makeSprint({ status: 'active', branch: 'existing-branch' });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        reorderByDependencies: () => Promise.resolve(),
        getTasks: () => Promise.resolve([]),
      }),
      ui: makeUi({
        selectBranchStrategy: () => {
          throw new Error('should not prompt when sprint.branch is set');
        },
      }),
      external: makeExternal({
        generateBranchName: () => {
          throw new Error('should not generate when sprint.branch is set');
        },
      }),
    });

    const pipeline = createExecuteSprintPipeline(deps);
    const result = await executePipeline(pipeline, makeInitialContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.context.branchName).toBe('existing-branch');
  });
});
