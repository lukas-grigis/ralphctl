import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';

/** Inputs to {@link CloseSprintUseCase}. */
export interface CloseSprintInput {
  readonly id: SprintId;
  readonly now: IsoTimestamp;
}

/**
 * `CloseSprintUseCase` — load an active sprint, close it via
 * {@link Sprint.close} (which clears `checkRanAt`), and persist.
 */
export class CloseSprintUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: CloseSprintInput): Promise<Result<Sprint, DomainError>> {
    const found = await this.sprints.findById(input.id);
    if (!found.ok) return Result.error(found.error);

    const closed = found.value.close(input.now);
    if (!closed.ok) return Result.error(closed.error);

    const saved = await this.sprints.save(closed.value);
    if (!saved.ok) return Result.error(saved.error);

    return Result.ok(closed.value);
  }
}
