import { Project, type ProjectCreateInput } from '@src/domain/entities/project.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { ConflictError } from '@src/domain/errors/conflict-error.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import { Result } from '@src/domain/result.ts';

/** Inputs to {@link CreateProjectUseCase}. */
export type CreateProjectInput = ProjectCreateInput;

/**
 * `CreateProjectUseCase` — construct a new {@link Project} via the entity
 * factory and persist it. Surfaces `ConflictError` when the project name
 * already exists (the registry is unique-by-name).
 */
export class CreateProjectUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  async execute(input: CreateProjectInput): Promise<Result<Project, DomainError>> {
    const projectResult = Project.create(input);
    if (!projectResult.ok) return Result.error(projectResult.error);

    const existing = await this.projects.findByName(input.name);
    if (existing.ok) {
      return Result.error(new ConflictError({ entity: 'project', conflictingId: input.name }));
    }
    if (existing.error.code !== 'not-found') {
      return Result.error(existing.error);
    }

    const saved = await this.projects.save(projectResult.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(projectResult.value);
  }
}
