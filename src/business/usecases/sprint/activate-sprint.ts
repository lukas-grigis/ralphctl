import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';

/** Inputs to {@link ActivateSprintUseCase}. */
export interface ActivateSprintInput {
  readonly id: SprintId;
  readonly now: IsoTimestamp;
}

/**
 * `ActivateSprintUseCase` — load a draft sprint, transition it to `active`
 * via {@link Sprint.activate}, and persist. Lifecycle invariants are
 * enforced by the entity.
 */
export class ActivateSprintUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: ActivateSprintInput): Promise<Result<Sprint, DomainError>> {
    const found = await this.sprints.findById(input.id);
    if (!found.ok) return Result.error(found.error);

    const activated = found.value.activate(input.now);
    if (!activated.ok) return Result.error(activated.error);

    const saved = await this.sprints.save(activated.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(activated.value);
  }
}
