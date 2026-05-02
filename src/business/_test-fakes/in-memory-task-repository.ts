import type { Task } from '@src/domain/entities/task.ts';
import { NotFoundError } from '@src/domain/errors/not-found-error.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';

/**
 * `InMemoryTaskRepository` — non-IO fake of {@link TaskRepository}.
 * Stores `Task[]` per sprint in a `Map<SprintId, Task[]>`. Never surfaces
 * {@link StorageError}.
 */
export class InMemoryTaskRepository implements TaskRepository {
  private readonly store = new Map<SprintId, readonly Task[]>();

  /**
   * Seed sprint-scoped task lists — accepts a tuple form so call-sites can
   * write `new InMemoryTaskRepository([[sprintId, [task1, task2]]])` without
   * pre-grouping.
   */
  constructor(initial?: readonly (readonly [SprintId, readonly Task[]])[]) {
    if (initial !== undefined) this.seed(initial);
  }

  seed(entries: readonly (readonly [SprintId, readonly Task[]])[]): void {
    for (const [sprintId, tasks] of entries) {
      this.store.set(sprintId, [...tasks]);
    }
  }

  saveAll(sprintId: SprintId, tasks: readonly Task[]): Promise<Result<void, StorageError>> {
    this.store.set(sprintId, [...tasks]);
    return Promise.resolve(Result.ok());
  }

  findBySprintId(sprintId: SprintId): Promise<Result<readonly Task[], StorageError>> {
    return Promise.resolve(Result.ok(this.store.get(sprintId) ?? []));
  }

  findById(sprintId: SprintId, taskId: TaskId): Promise<Result<Task, NotFoundError | StorageError>> {
    const tasks = this.store.get(sprintId) ?? [];
    const found = tasks.find((t) => t.id === taskId);
    if (found === undefined) {
      return Promise.resolve(Result.error(new NotFoundError({ entity: 'task', id: taskId })));
    }
    return Promise.resolve(Result.ok(found));
  }

  update(sprintId: SprintId, task: Task): Promise<Result<void, NotFoundError | StorageError>> {
    const tasks = this.store.get(sprintId);
    if (tasks === undefined) {
      return Promise.resolve(Result.error(new NotFoundError({ entity: 'task', id: task.id })));
    }
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx === -1) {
      return Promise.resolve(Result.error(new NotFoundError({ entity: 'task', id: task.id })));
    }
    const next = [...tasks];
    next[idx] = task;
    this.store.set(sprintId, next);
    return Promise.resolve(Result.ok());
  }
}
