import type { Project } from '@src/domain/entities/project.ts';
import { Repository, type RepositoryCreateInput } from '@src/domain/entities/repository.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';

/** Inputs to {@link AddRepositoryToProjectUseCase}. */
export interface AddRepositoryToProjectInput {
  readonly projectName: ProjectName;
  readonly repository: RepositoryCreateInput;
}

/**
 * `AddRepositoryToProjectUseCase` — append a {@link Repository} to a
 * project. Validation for the repo (name, checkScript, checkTimeout) lives
 * on the entity factory; aggregate-level uniqueness (path) is enforced by
 * `Project.addRepository`.
 */
export class AddRepositoryToProjectUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  async execute(input: AddRepositoryToProjectInput): Promise<Result<Project, DomainError>> {
    const found = await this.projects.findByName(input.projectName);
    if (!found.ok) return Result.error(found.error);

    const repoResult = Repository.create(input.repository);
    if (!repoResult.ok) return Result.error(repoResult.error);

    const updated = found.value.addRepository(repoResult.value);
    if (!updated.ok) return Result.error(updated.error);

    const saved = await this.projects.save(updated.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(updated.value);
  }
}
