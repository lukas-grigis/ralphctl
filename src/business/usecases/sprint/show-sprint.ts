import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import type { Result } from '../../../domain/result.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';

/** Inputs to {@link ShowSprintUseCase}. */
export interface ShowSprintInput {
  readonly id: SprintId;
}

/**
 * `ShowSprintUseCase` — fetch a sprint by id; surfaces `NotFoundError` when
 * the id is unknown.
 */
export class ShowSprintUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  execute(input: ShowSprintInput): Promise<Result<Sprint, DomainError>> {
    return this.sprints.findById(input.id);
  }
}
