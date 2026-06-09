import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { recordQuarantineUseCase } from '@src/business/task/record-quarantine.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const SPRINT_ID = '01900000-0000-7000-8000-0000000000aa' as unknown as SprintId;
const STASH = 'ralphctl/01900000-0000-7000-8000-0000000000aa/task-1/blocked-diff';

const makeBlockedTask = (reason = 'verify failed: 3 tests red'): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask(), reason, 'own');
  if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
  return r.value;
};

interface RepoDouble {
  readonly repo: UpdateTask;
  readonly saved: () => Task | undefined;
  readonly calls: () => number;
}

const repoWith = (result: Result<void, StorageError> = Result.ok(undefined)): RepoDouble => {
  let saved: Task | undefined;
  let calls = 0;
  return {
    repo: {
      async update(_sprintId, task) {
        calls += 1;
        saved = task;
        return result;
      },
    },
    saved: () => saved,
    calls: () => calls,
  };
};

describe('recordQuarantineUseCase', () => {
  it('appends the stash pointer to blockedReason and persists', async () => {
    const task = makeBlockedTask('verify failed: 3 tests red');
    const { repo, saved, calls } = repoWith();

    const res = await recordQuarantineUseCase({
      task,
      sprintId: SPRINT_ID,
      stashMessage: STASH,
      taskRepo: repo,
      logger: noopLogger,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Original reason preserved + the recovery line appended naming the stash message.
    expect(res.value.blockedReason).toContain('verify failed: 3 tests red');
    expect(res.value.blockedReason).toContain(STASH);
    expect(res.value.blockedReason).toMatch(/git stash list/);
    expect(calls()).toBe(1);
    expect((saved() as BlockedTask).blockedReason).toBe(res.value.blockedReason);
  });

  it('is idempotent — re-recording the same stash message does not duplicate the line or re-write', async () => {
    const task = makeBlockedTask();
    const { repo } = repoWith();

    const first = await recordQuarantineUseCase({
      task,
      sprintId: SPRINT_ID,
      stashMessage: STASH,
      taskRepo: repo,
      logger: noopLogger,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const repo2 = repoWith();
    const second = await recordQuarantineUseCase({
      task: first.value, // already carries the pointer
      sprintId: SPRINT_ID,
      stashMessage: STASH,
      taskRepo: repo2.repo,
      logger: noopLogger,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // No second recovery line, no redundant persist.
    expect(second.value.blockedReason).toBe(first.value.blockedReason);
    expect(second.value.blockedReason.match(/git stash list/g)?.length).toBe(1);
    expect(repo2.calls()).toBe(0);
  });

  it('rejects a non-blocked task with InvalidStateError (no repo write)', async () => {
    const todo = makeTodoTask();
    const { repo, calls } = repoWith();

    const res = await recordQuarantineUseCase({
      task: todo as unknown as BlockedTask,
      sprintId: SPRINT_ID,
      stashMessage: STASH,
      taskRepo: repo,
      logger: noopLogger,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-state');
    expect(calls()).toBe(0);
  });

  it('surfaces a persistence StorageError', async () => {
    const task = makeBlockedTask();
    const { repo } = repoWith(Result.error(new StorageError({ subCode: 'io', message: 'disk full' })));

    const res = await recordQuarantineUseCase({
      task,
      sprintId: SPRINT_ID,
      stashMessage: STASH,
      taskRepo: repo,
      logger: noopLogger,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('storage-error');
  });
});
