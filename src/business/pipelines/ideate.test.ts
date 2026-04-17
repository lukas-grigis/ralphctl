import { describe, expect, it } from 'vitest';
import type { ImportTask, Project, Sprint, Task } from '@src/domain/models.ts';
import { ParseError, ProjectNotFoundError, SprintStatusError, StepError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { createIdeatePipeline, type IdeateDeps } from './ideate.ts';

// ---------------------------------------------------------------------------
// Minimal in-memory stubs
// ---------------------------------------------------------------------------

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'test-sprint',
    name: 'Test Sprint',
    projectId: 'proj-1',
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
    id: 'proj-1',
    name: 'proj',
    displayName: 'Project',
    repositories: [{ id: 'repo-1', name: 'repo', path: '/tmp/repo' }],
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

function makeDeps(overrides: Partial<IdeateDeps> = {}): IdeateDeps {
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
 * Build a persistence stub that lets `run-ideation` succeed in `auto` mode
 * without touching real infrastructure. The use case's ideate flow calls
 * getSprint (multiple times — initial, after save, after AI) → getProject
 * → saveSprint (multiple) → (AI) → getTasks → validateImportTasks →
 * importTasks → reorderByDependencies.
 */
function makeHappyPathPersistence(initialSprint: Sprint, project: Project): PersistencePort {
  // Mutable reference — each saveSprint replaces it so subsequent getSprint
  // reads see the ticket the use case just pushed.
  let current: Sprint = initialSprint;
  const tasks: Task[] = [];
  return makePersistence({
    getSprint: () => Promise.resolve(current),
    getTasks: () => Promise.resolve(tasks),
    getProject: (name: string) => {
      if (name === project.name) return Promise.resolve(project);
      return Promise.reject(new Error(`unknown project: ${name}`));
    },
    getProjectById: (id: string) => {
      if (id === project.id) return Promise.resolve(project);
      return Promise.reject(new Error(`unknown project id: ${id}`));
    },
    saveSprint: (s: Sprint) => {
      current = s;
      return Promise.resolve();
    },
    validateImportTasks: () => [],
    importTasks: (importTasks: ImportTask[]) => Promise.resolve(importTasks.length),
    reorderByDependencies: () => Promise.resolve(),
  });
}

const HAPPY_IDEA = { title: 'Add dark mode', description: 'Toggle for the app theme' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createIdeatePipeline', () => {
  it('happy path: runs all five steps in order and records summary + ticketId', async () => {
    const sprint = makeSprint();
    const project = makeProject();

    const importTasks: ImportTask[] = [
      {
        name: 'Generated task',
        description: 'desc',
        steps: ['do it'],
        verificationCriteria: ['it works'],
        repoId: 'repo-1',
        blockedBy: [],
      },
    ];

    const deps = makeDeps({
      persistence: makeHappyPathPersistence(sprint, project),
      fs: makeFs({
        readFile: () => Promise.resolve('{}'),
        getSprintDir: () => '/tmp/sprint',
        getIdeationDir: () => '/tmp/sprint/ideation/ticket',
        ensureDir: () => Promise.resolve(),
      }),
      aiSession: makeAiSession({
        getProviderDisplayName: () => 'Claude',
        spawnHeadless: () =>
          Promise.resolve({
            output: JSON.stringify({ requirements: 'The requirements', tasks: importTasks }),
            sessionId: 'test-session',
          }),
      }),
      promptBuilder: makePromptBuilder({
        buildIdeateAutoPrompt: () => 'prompt text',
      }),
      parser: makeParser({
        parsePlanningBlocked: () => null,
        parseIdeation: () => ({ requirements: 'The requirements', tasks: importTasks }),
        parseTasks: () => importTasks,
      }),
      external: makeExternal({
        detectProjectTooling: () => '',
      }),
    });

    const pipeline = createIdeatePipeline(deps, HAPPY_IDEA, { auto: true, allPaths: true, project: 'proj' });
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.stepResults.map((r) => r.stepName);
    expect(stepNames).toEqual([
      'load-sprint',
      'assert-draft',
      'assert-project-provided',
      'run-ideation',
      'reorder-dependencies',
    ]);

    const summary = result.value.context.ideaSummary;
    expect(summary).toBeDefined();
    expect(summary?.requirements).toBe('The requirements');
    expect(summary?.importedTasks).toBe(1);
    expect(summary?.ticketId).toBeTruthy();

    // createdTicketId mirrors summary.ticketId on context for future steps.
    expect(result.value.context.createdTicketId).toBe(summary?.ticketId);
  });

  it('active sprint fails at assert-draft with SprintStatusError', async () => {
    const sprint = makeSprint({ status: 'active' });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
    });

    const pipeline = createIdeatePipeline(deps, HAPPY_IDEA, { project: 'proj' });
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const err = result.error;
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).stepName).toBe('assert-draft');
    expect((err as StepError).cause).toBeInstanceOf(SprintStatusError);
  });

  it('missing project option fails at assert-project-provided with ParseError', async () => {
    const sprint = makeSprint();
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
    });

    const pipeline = createIdeatePipeline(deps, HAPPY_IDEA, { auto: true });
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const err = result.error;
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).stepName).toBe('assert-project-provided');
    expect((err as StepError).cause).toBeInstanceOf(ParseError);
    expect((err as StepError).cause?.message).toMatch(/Project name is required/);
  });

  it('unknown project fails at run-ideation with ProjectNotFoundError', async () => {
    const sprint = makeSprint();
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
        getProject: () => Promise.reject(new Error('no such project')),
        getProjectById: () => Promise.reject(new Error('no such project')),
      }),
    });

    const pipeline = createIdeatePipeline(deps, HAPPY_IDEA, { auto: true, project: 'unknown-project' });
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const err = result.error;
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).stepName).toBe('run-ideation');
    expect((err as StepError).cause).toBeInstanceOf(ProjectNotFoundError);
  });

  it('missing sprint fails at load-sprint and does not advance', async () => {
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.reject(new Error('no such sprint')),
      }),
    });

    const pipeline = createIdeatePipeline(deps, HAPPY_IDEA, { auto: true, project: 'proj' });
    const result = await executePipeline(pipeline, { sprintId: 'missing' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).stepName).toBe('load-sprint');
  });
});
