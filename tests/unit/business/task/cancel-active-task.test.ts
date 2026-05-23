import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { cancelActiveTaskUseCase } from '@src/business/task/cancel-active-task.ts';
import { markTaskBlocked, type BlockedTask, type Task } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeDoneTask, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const SPRINT_ID = '01900000-0000-7000-8000-0000000000aa' as unknown as SprintId;

const makeBlockedTask = (reason = 'prior cancel'): BlockedTask => {
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

describe('cancelActiveTaskUseCase', () => {
  it('transitions a todo task to blocked with the supplied reason', async () => {
    const todo = makeTodoTask();
    const repo = repoOk();
    const result = await cancelActiveTaskUseCase({
      task: todo,
      sprintId: SPRINT_ID,
      reason: 'user cancel',
      taskRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('blocked');
    expect(result.value.blockedReason).toBe('user cancel');
    expect(repo.saved).toHaveLength(1);
  });

  it('transitions an in_progress task to blocked', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const repo = repoOk();
    const result = await cancelActiveTaskUseCase({
      task: inProgress,
      sprintId: SPRINT_ID,
      reason: 'user cancel',
      taskRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('blocked');
    expect(repo.saved).toHaveLength(1);
  });

  it('idempotent — already-blocked task passes through without re-saving', async () => {
    const blocked = makeBlockedTask();
    const repo = repoOk();
    const result = await cancelActiveTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      reason: 'user cancel',
      taskRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('blocked');
    expect(repo.saved).toHaveLength(0);
  });

  it('rejects a done task with InvalidStateError', async () => {
    const done = makeDoneTask();
    const repo = repoOk();
    const result = await cancelActiveTaskUseCase({
      task: done,
      sprintId: SPRINT_ID,
      reason: 'user cancel',
      taskRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(repo.saved).toHaveLength(0);
  });

  it('propagates StorageError when the repository update call fails', async () => {
    const todo = makeTodoTask();
    const result = await cancelActiveTaskUseCase({
      task: todo,
      sprintId: SPRINT_ID,
      reason: 'user cancel',
      taskRepo: repoFailing(),
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
  });
});
