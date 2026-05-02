import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { SprintRepository } from '@src/domain/repositories/sprint-repository.ts';
import type { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';

/** Inputs to {@link RemoveSprintUseCase}. */
export interface RemoveSprintInput {
  readonly id: SprintId;
}

/**
 * `RemoveSprintUseCase` — delete a sprint and its nested data. Surfaces
 * `NotFoundError` when the id does not exist.
 */
export class RemoveSprintUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  execute(input: RemoveSprintInput): Promise<Result<void, DomainError>> {
    return this.sprints.remove(input.id);
  }
}
