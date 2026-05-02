import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { NotFoundError } from '@src/domain/errors/not-found-error.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import type { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';

/**
 * `SprintRepository` — persistence port for the {@link Sprint} aggregate.
 *
 * Tickets are nested inside the `Sprint` aggregate root and are persisted
 * via `save()` together with the sprint. There is no separate ticket
 * repository — the aggregate boundary is the unit of persistence.
 *
 * All methods return `Result<T, DomainError>` — implementations never
 * throw at the port boundary. `findById` / `remove` surface
 * {@link NotFoundError} when the id does not exist; everything else is a
 * {@link StorageError} (I/O, lock contention, parse, schema mismatch).
 */
export interface SprintRepository {
  /** Persist a sprint. Creates or replaces atomically under the sprint id. */
  save(sprint: Sprint): Promise<Result<void, StorageError>>;
  /** Look up a sprint by id. Returns `NotFoundError` if no such sprint exists. */
  findById(id: SprintId): Promise<Result<Sprint, NotFoundError | StorageError>>;
  /** Enumerate every persisted sprint. Order is implementation-defined. */
  list(): Promise<Result<readonly Sprint[], StorageError>>;
  /** Delete a sprint and its nested data. */
  remove(id: SprintId): Promise<Result<void, NotFoundError | StorageError>>;
}
