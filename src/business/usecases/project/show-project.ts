import type { Project } from '../../../domain/entities/project.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { ProjectRepository } from '../../../domain/repositories/project-repository.ts';
import type { Result } from '../../../domain/result.ts';
import type { ProjectName } from '../../../domain/values/project-name.ts';

/** Inputs to {@link ShowProjectUseCase}. */
export interface ShowProjectInput {
  readonly name: ProjectName;
}

/** `ShowProjectUseCase` — fetch a project by name; surfaces `NotFoundError`. */
export class ShowProjectUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  execute(input: ShowProjectInput): Promise<Result<Project, DomainError>> {
    return this.projects.findByName(input.name);
  }
}
