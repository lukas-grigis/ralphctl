import type { Project } from '../../../domain/entities/project.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { ProjectRepository } from '../../../domain/repositories/project-repository.ts';
import type { Result } from '../../../domain/result.ts';

/** `ListProjectsUseCase` — enumerate every persisted project. */
export class ListProjectsUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  execute(): Promise<Result<readonly Project[], DomainError>> {
    return this.projects.list();
  }
}
