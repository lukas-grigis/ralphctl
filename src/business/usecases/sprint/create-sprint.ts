import { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { ProjectName } from '@src/domain/values/project-name.ts';
import type { Slug } from '@src/domain/values/slug.ts';

/** Inputs to {@link CreateSprintUseCase}. */
export interface CreateSprintInput {
  readonly name: string;
  readonly slug: Slug;
  readonly now: IsoTimestamp;
  /**
   * Project this sprint targets. Sprint-per-project is the architectural
   * invariant — every ticket inside the sprint inherits the project, and
   * repo selection at planning time stores absolute paths drawn from this
   * project's repositories.
   */
  readonly projectName: ProjectName;
}

/**
 * `CreateSprintUseCase` — construct a new draft sprint via {@link Sprint.create}
 * and persist it. Validation lives on the entity; the use case is thin.
 */
export class CreateSprintUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: CreateSprintInput): Promise<Result<Sprint, DomainError>> {
    const sprintResult = Sprint.create({
      name: input.name,
      slug: input.slug,
      now: input.now,
      projectName: input.projectName,
    });
    if (!sprintResult.ok) return Result.error(sprintResult.error);

    const saved = await this.sprints.save(sprintResult.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(sprintResult.value);
  }
}
