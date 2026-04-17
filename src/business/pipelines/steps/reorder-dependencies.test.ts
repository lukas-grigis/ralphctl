import { describe, expect, it, vi } from 'vitest';
import { DependencyCycleError, StorageError } from '@src/domain/errors.ts';
import type { Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { StepContext } from '@src/domain/context.ts';
import { reorderDependenciesStep } from './reorder-dependencies.ts';

interface Ctx extends StepContext {
  tasks?: Task[];
}

function makeTask(id: string, order: number): Task {
  return {
    id,
    name: `Task ${id}`,
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order,
    blockedBy: [],
    repoId: 'repo0001',
    verified: false,
    evaluated: false,
  };
}

function makePersistence(overrides: Partial<PersistencePort>): PersistencePort {
  return { ...({} as PersistencePort), ...overrides };
}

describe('reorderDependenciesStep', () => {
  it('reorders then refreshes tasks from persistence', async () => {
    const reordered = [makeTask('b', 1), makeTask('a', 2)];
    const reorder = vi.fn(() => Promise.resolve());
    const getTasks = vi.fn(() => Promise.resolve(reordered));

    const step = reorderDependenciesStep<Ctx>(makePersistence({ reorderByDependencies: reorder, getTasks }));

    const result = await step.execute({ sprintId: 's1' });
    expect(reorder).toHaveBeenCalledWith('s1');
    expect(getTasks).toHaveBeenCalledWith('s1');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ tasks: reordered });
  });

  it('propagates domain errors unchanged', async () => {
    const cycleErr = new DependencyCycleError(['a', 'b', 'a']);
    const step = reorderDependenciesStep<Ctx>(
      makePersistence({
        reorderByDependencies: () => Promise.reject(cycleErr),
      })
    );

    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(cycleErr);
  });

  it('wraps unknown errors as StorageError', async () => {
    const step = reorderDependenciesStep<Ctx>(
      makePersistence({
        reorderByDependencies: () => Promise.reject(new Error('boom')),
      })
    );

    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StorageError);
  });
});
