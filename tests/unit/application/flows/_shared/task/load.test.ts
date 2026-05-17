import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { type LoadTasksCtx, loadTasksLeaf } from '@src/application/flows/_shared/task/load.ts';

const fakeRepo = (opts: { tasks?: readonly Task[]; failFind?: StorageError } = {}): FindTasksBySprintId => ({
  async findBySprintId(_id: SprintId) {
    void _id;
    if (opts.failFind) return Result.error(opts.failFind);
    return Result.ok(opts.tasks ?? []);
  },
});

describe('loadTasksLeaf', () => {
  it('loads the tasks and writes them onto ctx', async () => {
    const sprint = makeDraftSprint();
    const tasks: readonly Task[] = [makeTodoTask({ name: 'task-a', order: 1 })];
    const el = loadTasksLeaf<LoadTasksCtx>({ taskRepo: fakeRepo({ tasks }) });

    const result = await el.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.tasks).toBe(tasks);
      expect(result.value.trace[0]?.elementName).toBe('load-tasks');
      expect(result.value.trace[0]?.status).toBe('completed');
    }
  });

  it('writes an empty array onto ctx when the sprint has no tasks', async () => {
    const sprint = makeDraftSprint();
    const el = loadTasksLeaf<LoadTasksCtx>({ taskRepo: fakeRepo() });

    const result = await el.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ctx.tasks).toEqual([]);
  });

  it('surfaces a storage error as a failed trace entry', async () => {
    const sprint = makeDraftSprint();
    const failure = new StorageError({ subCode: 'io', message: 'disk lost' });
    const el = loadTasksLeaf<LoadTasksCtx>({ taskRepo: fakeRepo({ failFind: failure }) });

    const result = await el.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(failure);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('honours a custom name', async () => {
    const sprint = makeDraftSprint();
    const el = loadTasksLeaf<LoadTasksCtx>({ taskRepo: fakeRepo() }, 'reload-tasks');

    const result = await el.execute({ sprintId: sprint.id });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trace[0]?.elementName).toBe('reload-tasks');
  });
});
