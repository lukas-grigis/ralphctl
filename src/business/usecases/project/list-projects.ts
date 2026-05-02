import type { Project } from '@src/domain/entities/project.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import type { Result } from '@src/domain/result.ts';

/** `ListProjectsUseCase` — enumerate every persisted project. */
export class ListProjectsUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  execute(): Promise<Result<readonly Project[], DomainError>> {
    return this.projects.list();
  }
}
