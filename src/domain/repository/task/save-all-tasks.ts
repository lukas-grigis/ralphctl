import type { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** Replace the full task set for a sprint atomically. Used by planning / re-plan. */
export interface SaveAllTasks {
  saveAll(sprintId: SprintId, tasks: readonly Task[]): Promise<Result<void, StorageError>>;
}
