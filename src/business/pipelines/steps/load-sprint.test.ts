import { describe, it, expect } from 'vitest';
import { SprintNotFoundError } from '@src/domain/errors.ts';
import type { Sprint } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { StepContext } from '@src/domain/context.ts';
import { loadSprintStep } from './load-sprint.ts';

interface Ctx extends StepContext {
  sprint?: Sprint;
}

function makeSprint(): Sprint {
  return {
    id: 's1',
    name: 'Sprint 1',
    status: 'draft',
    createdAt: new Date().toISOString(),
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
  };
}

function makePersistence(overrides: Partial<PersistencePort> = {}): PersistencePort {
  const stub = {} as PersistencePort;
  return { ...stub, ...overrides };
}

describe('loadSprintStep', () => {
  it('loads the sprint from persistence into ctx.sprint', async () => {
    const sprint = makeSprint();
    const step = loadSprintStep<Ctx>(
      makePersistence({
        getSprint: () => Promise.resolve(sprint),
      })
    );

    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ sprint });
  });

  it('returns SprintNotFoundError when persistence throws SprintNotFoundError', async () => {
    const step = loadSprintStep<Ctx>(
      makePersistence({
        getSprint: () => Promise.reject(new SprintNotFoundError('missing')),
      })
    );

    const result = await step.execute({ sprintId: 'missing' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(SprintNotFoundError);
  });

  it('converts unknown errors to SprintNotFoundError', async () => {
    const step = loadSprintStep<Ctx>(
      makePersistence({
        getSprint: () => Promise.reject(new Error('file not found')),
      })
    );

    const result = await step.execute({ sprintId: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(SprintNotFoundError);
  });
});
