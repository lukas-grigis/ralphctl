import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { unblockTaskUseCase } from '@src/business/task/unblock-task.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { BLOCKED_UPSTREAM_REASON_PREFIX, markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
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

type Repo = UpdateTask & FindTasksBySprintId & SaveAllTasks;
interface RepoDouble {
  readonly repo: Repo;
  /** Tasks handed to the most recent persistence call (saveAll list, or a single update). */
  readonly saved: () => readonly Task[];
}

// Seeds the sprint's task list for findBySprintId and records whatever the use case persists.
const repoOk = (seed: readonly Task[] = []): RepoDouble => {
  let saved: Task[] = [];
  const repo: Repo = {
    async update(_sprintId, task) {
      saved = [task];
      return Result.ok(undefined);
    },
    async findBySprintId() {
      return Result.ok(seed);
    },
    async saveAll(_sprintId, tasks) {
      saved = [...tasks];
      return Result.ok(undefined);
    },
  };
  return { repo, saved: () => saved };
};

// Persistence fails on the saveAll path (the cascade write).
const repoFailing = (seed: readonly Task[] = []): Repo => ({
  async update() {
    return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'tasks' }));
  },
  async findBySprintId() {
    return Result.ok(seed);
  },
  async saveAll() {
    return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'tasks' }));
  },
});

describe('unblockTaskUseCase', () => {
  it('transitions blocked → todo, strips blockedReason, and persists', async () => {
    const blocked = makeBlockedTask('mvn agent attach failed');
    const repo = repoOk([blocked]);

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect((result.value as unknown as { blockedReason?: string }).blockedReason).toBeUndefined();
    expect(repo.saved()).toHaveLength(1);
    expect(repo.saved()[0]?.status).toBe('todo');
  });

  it('idempotent — already-todo passes through without re-saving', async () => {
    const todo = makeTodoTask();
    const repo = repoOk([todo]);

    const result = await unblockTaskUseCase({
      task: todo,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect(repo.saved()).toHaveLength(0);
  });

  it('rejects an in_progress task with InvalidStateError', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const repo = repoOk([inProgress]);

    const result = await unblockTaskUseCase({
      task: inProgress,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(repo.saved()).toHaveLength(0);
  });

  it('rejects a done task with InvalidStateError', async () => {
    const done = makeDoneTask();
    const repo = repoOk([done]);

    const result = await unblockTaskUseCase({
      task: done,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(repo.saved()).toHaveLength(0);
  });

  it('propagates StorageError when persistence fails', async () => {
    const blocked = makeBlockedTask();

    const result = await unblockTaskUseCase({
      task: blocked,
      sprintId: SPRINT_ID,
      taskRepo: repoFailing([blocked]),
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
  });

  it('cascade-unblocks upstream-blocked dependents when the root is unblocked', async () => {
    const root = makeBlockedTask('own failure: eval did not pass'); // own-failure block on the root
    const depTodo = makeTodoTask({ name: 'dependent', dependsOn: [root.id] });
    const depUpstream = markTaskBlocked(depTodo, `${BLOCKED_UPSTREAM_REASON_PREFIX} — prerequisite not done: root`);
    if (!depUpstream.ok) throw depUpstream.error;
    const repo = repoOk([root, depUpstream.value]);

    const result = await unblockTaskUseCase({
      task: root,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    const saved = repo.saved();
    expect(saved.find((t) => t.id === root.id)?.status).toBe('todo');
    // The dependent the dependency gate parked is re-armed in the same transaction.
    expect(saved.find((t) => t.id === depUpstream.value.id)?.status).toBe('todo');
  });

  it('does NOT cascade-unblock a dependent blocked for its own failure', async () => {
    const root = makeBlockedTask('root own failure');
    const depTodo = makeTodoTask({ name: 'dependent', dependsOn: [root.id] });
    const depOwn = markTaskBlocked(depTodo, 'verify failed on the dependent itself'); // NOT an upstream prefix
    if (!depOwn.ok) throw depOwn.error;
    const repo = repoOk([root, depOwn.value]);

    const result = await unblockTaskUseCase({
      task: root,
      sprintId: SPRINT_ID,
      taskRepo: repo.repo,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    const saved = repo.saved();
    expect(saved.find((t) => t.id === root.id)?.status).toBe('todo');
    // The dependent failed on its own merits — it is NOT in the cascade, so it is left untouched
    // on disk (only the primary is re-persisted). It stays blocked for the operator to fix.
    expect(saved.find((t) => t.id === depOwn.value.id)).toBeUndefined();
  });
});
