import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import type { SprintRepository } from '../../../domain/repositories/sprint-repository.ts';
import { Result } from '../../../domain/result.ts';
import type { SprintId } from '../../../domain/values/sprint-id.ts';

/** Inputs to {@link EditSprintUseCase}. */
export interface EditSprintInput {
  readonly id: SprintId;
  /** New sprint name. Optional — omit to leave the current name in place. */
  readonly name?: string;
  /**
   * New branch. Optional — omit to leave it untouched, pass `null` to clear
   * a previously-set branch (delegates to {@link Sprint.clearBranch}).
   */
  readonly branch?: string | null;
}

/**
 * `EditSprintUseCase` — load a sprint, apply name and/or branch changes via
 * the entity's own state-guarded mutators, then persist. Use cases never
 * bypass the entity to write fields directly — every transition runs through
 * the lifecycle invariants (closed sprints reject; empty names reject).
 */
export class EditSprintUseCase {
  constructor(private readonly sprints: SprintRepository) {}

  async execute(input: EditSprintInput): Promise<Result<Sprint, DomainError>> {
    const found = await this.sprints.findById(input.id);
    if (!found.ok) return Result.error(found.error);

    let current = found.value;

    if (input.name !== undefined) {
      const renamed = current.rename(input.name);
      if (!renamed.ok) return Result.error(renamed.error);
      current = renamed.value;
    }

    if (input.branch !== undefined) {
      const next = input.branch === null ? current.clearBranch() : current.setBranch(input.branch);
      if (!next.ok) return Result.error(next.error);
      current = next.value;
    }

    const saved = await this.sprints.save(current);
    if (!saved.ok) return Result.error(saved.error);
    return Result.ok(current);
  }
}
