import { describe, expect, it } from 'vitest';
import { StorageError } from '@src/domain/errors.ts';
import type { Task } from '@src/domain/models.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { StepContext } from '@src/domain/context.ts';
import { loadTasksStep } from './load-tasks.ts';

interface Ctx extends StepContext {
  tasks?: Task[];
}

function makeTask(id: string): Task {
  return {
    id,
    name: `Task ${id}`,
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    projectPath: '/tmp/project',
    verified: false,
    evaluated: false,
  };
}

function makePersistence(overrides: Partial<PersistencePort> = {}): PersistencePort {
  return { ...({} as PersistencePort), ...overrides };
}

describe('loadTasksStep', () => {
  it('loads tasks into ctx.tasks', async () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const step = loadTasksStep<Ctx>(
      makePersistence({
        getTasks: () => Promise.resolve(tasks),
      })
    );

    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ tasks });
  });

  it('wraps unknown errors as StorageError', async () => {
    const step = loadTasksStep<Ctx>(
      makePersistence({
        getTasks: () => Promise.reject(new Error('disk full')),
      })
    );

    const result = await step.execute({ sprintId: 's1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(StorageError);
  });
});
