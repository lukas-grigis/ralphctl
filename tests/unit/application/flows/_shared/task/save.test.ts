import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { type SaveTasksCtx, saveTasksLeaf } from '@src/application/flows/_shared/task/save.ts';

interface SaveCall {
  readonly sprintId: SprintId;
  readonly tasks: readonly Task[];
}

const fakeRepo = (opts: { failSave?: StorageError } = {}): { repo: SaveAllTasks; calls: SaveCall[] } => {
  const calls: SaveCall[] = [];
  const repo: SaveAllTasks = {
    async saveAll(sprintId, tasks) {
      if (opts.failSave) return Result.error(opts.failSave);
      calls.push({ sprintId, tasks });
      return Result.ok(undefined);
    },
  };
  return { repo, calls };
};

describe('saveTasksLeaf', () => {
  it('persists ctx.tasks under ctx.sprintId and returns ctx unchanged', async () => {
    const sprint = makeDraftSprint();
    const tasks: readonly Task[] = [makeTodoTask({ name: 'task-a', order: 1 })];
    const { repo, calls } = fakeRepo();
    const el = saveTasksLeaf<SaveTasksCtx>({ taskRepo: repo });

    const result = await el.execute({ sprintId: sprint.id, tasks });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ sprintId: sprint.id, tasks });
      expect(result.value.trace[0]?.status).toBe('completed');
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sprintId).toBe(sprint.id);
    expect(calls[0]?.tasks).toBe(tasks);
  });

  it('surfaces a storage error as a failed trace entry', async () => {
    const sprint = makeDraftSprint();
    const failure = new StorageError({ subCode: 'io', message: 'disk full' });
    const { repo } = fakeRepo({ failSave: failure });
    const el = saveTasksLeaf<SaveTasksCtx>({ taskRepo: repo });

    const result = await el.execute({ sprintId: sprint.id, tasks: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(failure);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('surfaces a missing-tasks precondition as a failed trace entry (chain wiring error)', async () => {
    const sprint = makeDraftSprint();
    const { repo } = fakeRepo();
    const el = saveTasksLeaf<SaveTasksCtx>({ taskRepo: repo });

    const result = await el.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });
});
