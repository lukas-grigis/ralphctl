import type { Project } from '@src/domain/entities/project.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import type { Result } from '@src/domain/result.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';

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
