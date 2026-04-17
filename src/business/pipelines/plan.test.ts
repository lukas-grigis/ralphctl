import { describe, it, expect } from 'vitest';
import type { Sprint, Ticket, Task, Project, ImportTask } from '@src/domain/models.ts';
import { ParseError, SprintStatusError, StepError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { executePipeline } from '@src/business/pipeline/pipeline.ts';
import { createPlanPipeline, type PlanDeps } from './plan.ts';

// ---------------------------------------------------------------------------
// Minimal in-memory stubs
// ---------------------------------------------------------------------------

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    title: 'Test ticket',
    projectName: 'proj',
    requirementStatus: 'approved',
    requirements: 'Some requirements',
    ...overrides,
  };
}

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'test-sprint',
    name: 'Test Sprint',
    status: 'draft',
    createdAt: new Date().toISOString(),
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'proj',
    displayName: 'Project',
    repositories: [{ name: 'repo', path: '/tmp/repo' }],
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

function makeDeps(overrides: Partial<PlanDeps> = {}): PlanDeps {
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
 * Build a persistence stub that lets `run-plan` succeed in `auto` mode
 * without touching real infrastructure: the use case calls getSprint →
 * getTasks → getProject → saveSprint → (AI) → validateImportTasks →
 * importTasks → reorderByDependencies.
 */
function makeHappyPathPersistence(sprint: Sprint, project: Project): PersistencePort {
  const tasks: Task[] = [];
  return makePersistence({
    getSprint: () => Promise.resolve(sprint),
    getTasks: () => Promise.resolve(tasks),
    getProject: (name: string) => {
      if (name === project.name) return Promise.resolve(project);
      return Promise.reject(new Error(`unknown project: ${name}`));
    },
    saveSprint: () => Promise.resolve(),
    validateImportTasks: () => [],
    importTasks: (importTasks: ImportTask[]) => Promise.resolve(importTasks.length),
    reorderByDependencies: () => Promise.resolve(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPlanPipeline', () => {
  it('happy path: runs all five steps in order with an approved ticket', async () => {
    const sprint = makeSprint({ tickets: [makeTicket()] });
    const project = makeProject();

    const importTasks: ImportTask[] = [
      {
        name: 'Generated task',
        description: 'desc',
        steps: ['do it'],
        verificationCriteria: ['it works'],
        projectPath: '/tmp/repo',
        blockedBy: [],
      } as ImportTask,
    ];

    const deps = makeDeps({
      persistence: makeHappyPathPersistence(sprint, project),
      fs: makeFs({
        getSchemaPath: () => '/tmp/schema.json',
        readFile: () => Promise.resolve('{}'),
        getPlanningDir: () => '/tmp/plan',
        ensureDir: () => Promise.resolve(),
      }),
      aiSession: makeAiSession({
        getProviderDisplayName: () => 'Claude',
        spawnHeadless: () =>
          Promise.resolve({
            output: JSON.stringify(importTasks),
            sessionId: 'test-session',
          }),
      }),
      promptBuilder: makePromptBuilder({
        buildPlanAutoPrompt: () => 'prompt text',
      }),
      parser: makeParser({
        parsePlanningBlocked: () => null,
        parseTasks: () => importTasks,
      }),
      external: makeExternal({
        detectProjectTooling: () => '',
      }),
    });

    const pipeline = createPlanPipeline(deps, { auto: true, allPaths: true });
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.stepResults.map((r) => r.stepName);
    expect(stepNames).toEqual([
      'load-sprint',
      'assert-draft',
      'assert-all-approved',
      'run-plan',
      'reorder-dependencies',
    ]);

    const summary = result.value.context.planSummary;
    expect(summary).toEqual({ importedCount: 1, totalGenerated: 1, isReplan: false });
  });

  it('active sprint fails at assert-draft with SprintStatusError', async () => {
    const sprint = makeSprint({ status: 'active', tickets: [makeTicket()] });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
    });

    const pipeline = createPlanPipeline(deps);
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const err = result.error;
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).stepName).toBe('assert-draft');
    expect((err as StepError).cause).toBeInstanceOf(SprintStatusError);
  });

  it('unapproved tickets fail at assert-all-approved with ParseError', async () => {
    const sprint = makeSprint({
      tickets: [
        makeTicket({ id: 't1', requirementStatus: 'approved' }),
        makeTicket({ id: 't2', requirementStatus: 'pending' }),
      ],
    });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
    });

    const pipeline = createPlanPipeline(deps);
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const err = result.error;
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).stepName).toBe('assert-all-approved');
    expect((err as StepError).cause).toBeInstanceOf(ParseError);
    expect((err as StepError).cause?.message).toMatch(/Not all tickets have approved requirements/);
  });

  it('empty sprint fails at assert-all-approved with ParseError', async () => {
    const sprint = makeSprint({ tickets: [] });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
    });

    const pipeline = createPlanPipeline(deps);
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect((result.error as StepError).stepName).toBe('assert-all-approved');
    expect((result.error as StepError).cause?.message).toMatch(/No tickets in sprint/);
  });

  it('missing sprint fails at load-sprint and does not advance', async () => {
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.reject(new Error('no such sprint')),
      }),
    });

    const pipeline = createPlanPipeline(deps);
    const result = await executePipeline(pipeline, { sprintId: 'missing' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).stepName).toBe('load-sprint');
  });
});
