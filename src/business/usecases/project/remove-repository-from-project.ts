import type { Project } from '../../../domain/entities/project.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { ProjectRepository } from '../../../domain/repositories/project-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { ProjectName } from '../../../domain/values/project-name.ts';

/** Inputs to {@link RemoveRepositoryFromProjectUseCase}. */
export interface RemoveRepositoryFromProjectInput {
  readonly projectName: ProjectName;
  readonly path: AbsolutePath;
}

/**
 * `RemoveRepositoryFromProjectUseCase` — drop a repository from a project.
 * The project must keep at least one repository — `Project.removeRepository`
 * enforces this with a `ValidationError` when called on the last repo.
 */
export class RemoveRepositoryFromProjectUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  async execute(input: RemoveRepositoryFromProjectInput): Promise<Result<Project, DomainError>> {
    const found = await this.projects.findByName(input.projectName);
    if (!found.ok) return Result.error(found.error);

    const updated = found.value.removeRepository(input.path);
    if (!updated.ok) return Result.error(updated.error);

    const saved = await this.projects.save(updated.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(updated.value);
  }
}
