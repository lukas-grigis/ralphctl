import type { Project } from '../entities/project.ts';
import type { NotFoundError } from '../errors/not-found-error.ts';
import type { StorageError } from '../errors/storage-error.ts';
import type { Result } from '../result.ts';
import type { ProjectName } from '../values/project-name.ts';

/**
 * `ProjectRepository` — persistence port for the {@link Project} aggregate.
 *
 * Repositories (the nested entity) are persisted as part of the project
 * aggregate root. Mutations to a repository — adding, removing, updating
 * its check script — go through the project and are saved via `save()`.
 *
 * All methods return `Result<T, DomainError>`. `findByName` / `remove`
 * surface {@link NotFoundError} when the name is unknown; storage backend
 * failures surface as {@link StorageError}.
 */
export interface ProjectRepository {
  /** Persist a project. Creates or replaces atomically under the project name. */
  save(project: Project): Promise<Result<void, StorageError>>;
  /** Look up a project by its slug name. */
  findByName(name: ProjectName): Promise<Result<Project, NotFoundError | StorageError>>;
  /** Enumerate every persisted project. Order is implementation-defined. */
  list(): Promise<Result<readonly Project[], StorageError>>;
  /** Delete a project and its nested repository registry. */
  remove(name: ProjectName): Promise<Result<void, NotFoundError | StorageError>>;
}
