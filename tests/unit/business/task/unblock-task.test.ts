import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { unblockTaskUseCase } from '@src/business/task/unblock-task.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeDoneTask, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const SPRINT_ID = '01900000-0000-7000-8000-0000000000aa' as unknown as SprintId;

const makeBlockedTask = (reason = 'flaky pre-task verify'): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask(), reason);
  if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
  return r.value;
};

interface RepoDouble extends UpdateTask {
  readonly saved: Task[];
}

const repoOk = (): RepoDouble => {
  const saved: Task[] = [];
  return {
    saved,
    async update(_sprintId, task) {
      saved.push(task);
      return Result.ok(undefined);
    },
  };
};

const repoFailing = (): UpdateTask => ({
  async update() {
    return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'tasks' }));
  },
});

describe('unblockTaskUseCase', () => {
  it('transitions blocked → todo, strips blockedReason, and persists', async () => {
    const blocked = makeBlockedTask('mvn agent attach failed');
    const repo = repoOk();

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect((result.value as unknown as { blockedReason?: string }).blockedReason).toBeUndefined();
    expect(repo.saved).toHaveLength(1);
    expect(repo.saved[0]?.status).toBe('todo');
  });

  it('idempotent — already-todo passes through without re-saving', async () => {
    const todo = makeTodoTask();
    const repo = repoOk();

    const result = await unblockTaskUseCase({
      task: todo,
      sprintId: SPRINT_ID,
      taskRepo: repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect(repo.saved).toHaveLength(0);
  });

  it('rejects an in_progress task with InvalidStateError', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const repo = repoOk();

    const result = await unblockTaskUseCase({
      task: inProgress,
      sprintId: SPRINT_ID,
      taskRepo: repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(repo.saved).toHaveLength(0);
  });

  it('rejects a done task with InvalidStateError', async () => {
    const done = makeDoneTask();
    const repo = repoOk();

    const result = await unblockTaskUseCase({
      task: done,
      sprintId: SPRINT_ID,
      taskRepo: repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(repo.saved).toHaveLength(0);
  });

  it('propagates StorageError when the repository update call fails', async () => {
    const blocked = makeBlockedTask();

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: repoFailing(),
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
  });
});
