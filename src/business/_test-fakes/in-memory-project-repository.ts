import type { Project } from '../../domain/entities/project.ts';
import { NotFoundError } from '../../domain/errors/not-found-error.ts';
import type { StorageError } from '../../domain/errors/storage-error.ts';
import type { ProjectRepository } from '../../domain/repositories/project-repository.ts';
import { Result } from '../../domain/result.ts';
import type { ProjectName } from '../../domain/values/project-name.ts';

/**
 * `InMemoryProjectRepository` — non-IO fake of {@link ProjectRepository}.
 * Backed by a `Map<ProjectName, Project>`; never surfaces a
 * {@link StorageError}.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly store = new Map<ProjectName, Project>();

  constructor(initial?: readonly Project[]) {
    if (initial !== undefined) this.seed(initial);
  }

  seed(projects: readonly Project[]): void {
    for (const project of projects) {
      this.store.set(project.name, project);
    }
  }

  save(project: Project): Promise<Result<void, StorageError>> {
    this.store.set(project.name, project);
    return Promise.resolve(Result.ok());
  }

  findByName(name: ProjectName): Promise<Result<Project, NotFoundError | StorageError>> {
    const found = this.store.get(name);
    if (found === undefined) {
      return Promise.resolve(Result.error(new NotFoundError({ entity: 'project', id: name })));
    }
    return Promise.resolve(Result.ok(found));
  }

  list(): Promise<Result<readonly Project[], StorageError>> {
    return Promise.resolve(Result.ok([...this.store.values()]));
  }

  remove(name: ProjectName): Promise<Result<void, NotFoundError | StorageError>> {
    if (!this.store.has(name)) {
      return Promise.resolve(Result.error(new NotFoundError({ entity: 'project', id: name })));
    }
    this.store.delete(name);
    return Promise.resolve(Result.ok());
  }
}
