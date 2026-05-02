import type { Project, RepositoryUpdate } from '@src/domain/entities/project.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';

/** Inputs to {@link UpdateRepositoryConfigUseCase}. */
export interface UpdateRepositoryConfigInput {
  readonly projectName: ProjectName;
  readonly path: AbsolutePath;
  readonly partial: RepositoryUpdate;
}

/**
 * `UpdateRepositoryConfigUseCase` — patch the editable fields (`name`,
 * `checkScript`, `checkTimeout`) on a repository within a project. Field-
 * level validation lives on the entity (`Repository.with*` / `create`); the
 * aggregate routes the edit through `Project.updateRepository`.
 */
export class UpdateRepositoryConfigUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  async execute(input: UpdateRepositoryConfigInput): Promise<Result<Project, DomainError>> {
    const found = await this.projects.findByName(input.projectName);
    if (!found.ok) return Result.error(found.error);

    const updated = found.value.updateRepository(input.path, input.partial);
    if (!updated.ok) return Result.error(updated.error);

    const saved = await this.projects.save(updated.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(updated.value);
  }
}
