import type { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Look up a single task by composite (sprintId, taskId) identity. Task ids are stored under
 * their owning sprint on disk, so reads need both keys.
 */
export interface FindTaskById {
  findById(sprintId: SprintId, taskId: TaskId): Promise<Result<Task, NotFoundError | StorageError>>;
}
