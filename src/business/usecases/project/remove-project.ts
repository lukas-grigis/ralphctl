import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { ProjectRepository } from '@src/domain/repositories/project-repository.ts';
import type { Result } from '@src/domain/result.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';

/** Inputs to {@link RemoveProjectUseCase}. */
export interface RemoveProjectInput {
  readonly name: ProjectName;
}

/**
 * `RemoveProjectUseCase` — delete a project from the registry.
 *
 * **Pure aggregate-level remove.** Does not check whether sprints or tickets
 * reference the project — that cross-aggregate guard belongs to a workflow
 * use case and is intentionally out of scope here.
 */
export class RemoveProjectUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  execute(input: RemoveProjectInput): Promise<Result<void, DomainError>> {
    return this.projects.remove(input.name);
  }
}
