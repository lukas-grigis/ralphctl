import type { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Return every task belonging to a sprint. No pagination — sprints are bounded in size and
 * the implement loop touches the full set on every iteration anyway.
 */
export interface FindTasksBySprintId {
  findBySprintId(sprintId: SprintId): Promise<Result<readonly Task[], StorageError>>;
}
