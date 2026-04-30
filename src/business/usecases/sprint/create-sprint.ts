import { Sprint } from '../../../domain/entities/sprint.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { Slug } from '../../../domain/values/slug.ts';

/** Inputs to {@link CreateSprintUseCase}. */
export interface CreateSprintInput {
  readonly name: string;
  readonly slug: Slug;
  readonly now: IsoTimestamp;
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
    });
    if (!sprintResult.ok) return Result.error(sprintResult.error);

    const saved = await this.sprints.save(sprintResult.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(sprintResult.value);
  }
}
