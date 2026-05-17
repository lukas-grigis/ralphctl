import type { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Hot-path single-task update. Implementations load the current task set, replace the
 * matching id, and save under a file lock.
 */
export interface UpdateTask {
  update(sprintId: SprintId, task: Task): Promise<Result<void, NotFoundError | StorageError>>;
}
