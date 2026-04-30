import type { Sprint } from '../../domain/entities/sprint.ts';
import { NotFoundError } from '../../domain/errors/not-found-error.ts';
import type { StorageError } from '../../domain/errors/storage-error.ts';
import type { SprintRepository } from '../../domain/repositories/sprint-repository.ts';
import { Result } from '../../domain/result.ts';
import type { SprintId } from '../../domain/values/sprint-id.ts';

/**
 * `InMemorySprintRepository` — non-IO fake of {@link SprintRepository} for
 * use case unit tests. Stores sprints in a `Map<SprintId, Sprint>` and never
 * surfaces a {@link StorageError} (no IO surface to fail on).
 */
export class InMemorySprintRepository implements SprintRepository {
  private readonly store = new Map<SprintId, Sprint>();

  constructor(initial?: readonly Sprint[]) {
    if (initial !== undefined) this.seed(initial);
  }

  /** Seed (or overwrite) sprints — convenience for in-test setup. */
  seed(sprints: readonly Sprint[]): void {
    for (const sprint of sprints) {
      this.store.set(sprint.id, sprint);
    }
  }

  save(sprint: Sprint): Promise<Result<void, StorageError>> {
    this.store.set(sprint.id, sprint);
    return Promise.resolve(Result.ok());
  }

  findById(id: SprintId): Promise<Result<Sprint, NotFoundError | StorageError>> {
    const found = this.store.get(id);
    if (found === undefined) {
      return Promise.resolve(Result.error(new NotFoundError({ entity: 'sprint', id })));
    }
    return Promise.resolve(Result.ok(found));
  }

  list(): Promise<Result<readonly Sprint[], StorageError>> {
    return Promise.resolve(Result.ok([...this.store.values()]));
  }

  remove(id: SprintId): Promise<Result<void, NotFoundError | StorageError>> {
    if (!this.store.has(id)) {
      return Promise.resolve(Result.error(new NotFoundError({ entity: 'sprint', id })));
    }
    this.store.delete(id);
    return Promise.resolve(Result.ok());
  }
}
