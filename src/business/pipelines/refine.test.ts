import { describe, expect, it } from 'vitest';
import type { Sprint } from '@src/domain/models.ts';
import { SprintStatusError, StepError } from '@src/domain/errors.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder.ts';
import type { OutputParserPort } from '@src/business/ports/output-parser.ts';
import type { UserInteractionPort } from '@src/business/ports/user-interaction.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { createRefinePipeline, type RefineDeps } from './refine.ts';

// ---------------------------------------------------------------------------
// Minimal in-memory stubs
// ---------------------------------------------------------------------------

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

/**
 * Build a `RefineDeps` graph where every port is unused by default.
 * The draft-with-no-tickets happy path exercises persistence/assert only.
 */
function makeDeps(overrides: Partial<RefineDeps> = {}): RefineDeps {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRefinePipeline', () => {
  it('happy path: runs all four steps in order on an empty draft sprint', async () => {
    const sprint = makeSprint({ status: 'draft', tickets: [] });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
    });

    const pipeline = createRefinePipeline(deps);
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const value = result.value;
    const stepNames = value.stepResults.map((r) => r.stepName);
    // allApproved is false (no tickets, so no approvals happened) — step 4
    // still runs; it just no-ops on the allApproved check.
    expect(stepNames).toEqual(['load-sprint', 'assert-draft', 'refine-tickets', 'export-requirements']);

    const summary = value.context.refineSummary;
    expect(summary).toEqual({ approved: 0, skipped: 0, total: 0, allApproved: false });
  });

  it('export-requirements calls exportRequirements when all tickets approve', async () => {
    // Initial sprint: one ticket, already approved → use case reports
    // pendingTickets.length === 0 and allApproved === true (because every
    // ticket in the sprint is approved).
    const sprint = makeSprint({
      tickets: [
        {
          id: 't1',
          title: 'Done ticket',
          projectName: 'proj',
          requirementStatus: 'approved',
          requirements: 'Already approved',
        },
      ],
    });

    let exportedWith: Sprint | null = null;
    // Spy on writeFile so we observe exportRequirements firing via the use
    // case without monkey-patching the use case itself.
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
      fs: makeFs({
        writeFile: () => {
          exportedWith = sprint;
          return Promise.resolve();
        },
        getSprintDir: (id: string) => `/tmp/sprints/${id}`,
      }),
    });

    const pipeline = createRefinePipeline(deps);
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stepNames = result.value.stepResults.map((r) => r.stepName);
    expect(stepNames).toEqual(['load-sprint', 'assert-draft', 'refine-tickets', 'export-requirements']);

    expect(result.value.context.refineSummary?.allApproved).toBe(true);
    expect(exportedWith).not.toBeNull();
  });

  it('active sprint fails at assert-draft with SprintStatusError', async () => {
    const sprint = makeSprint({ status: 'active' });
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.resolve(sprint),
      }),
    });

    const pipeline = createRefinePipeline(deps);
    const result = await executePipeline(pipeline, { sprintId: 'test-sprint' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // executePipeline wraps step errors in a StepError that references the
    // failing step name; the original SprintStatusError is on `.cause`.
    const err = result.error;
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).stepName).toBe('assert-draft');
    expect((err as StepError).cause).toBeInstanceOf(SprintStatusError);
  });

  it('missing sprint fails at load-sprint and does not advance', async () => {
    const deps = makeDeps({
      persistence: makePersistence({
        getSprint: () => Promise.reject(new Error('no such sprint')),
      }),
    });

    const pipeline = createRefinePipeline(deps);
    const result = await executePipeline(pipeline, { sprintId: 'missing' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StepError);
    expect((result.error as StepError).stepName).toBe('load-sprint');
  });
});
