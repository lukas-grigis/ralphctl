import type { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * Locked read-modify-write of one sprint: `mutate` sees the sprint as it is on disk now, so a
 * writer that held a copy across a long session cannot overwrite what others wrote meanwhile.
 * Returning the sprint it was given writes nothing.
 */
export interface UpdateSprint {
  update(id: SprintId, mutate: (fresh: Sprint) => Result<Sprint, DomainError>): Promise<Result<Sprint, DomainError>>;
}
