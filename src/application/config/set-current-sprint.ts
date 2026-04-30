/**
 * `SetCurrentSprintUseCase` — application-layer coordinator that updates
 * the global `currentSprint` pointer in `Config`.
 *
 * Lives at the application layer (not in business/usecases/) because
 * `currentSprint` is an application concern — the config file is owned by
 * the composition root, not the business model. The use case verifies that
 * the target sprint exists via `SprintRepository.findById()` so a stale or
 * mistyped id cannot land in config and silently break every subsequent
 * `currentSprint`-keyed command.
 *
 * Pass `id: null` to clear the pointer without verifying anything.
 */
import type { DomainError } from '../../domain/errors/domain-error.ts';
import type { SprintRepository } from '../../domain/repositories/sprint-repository.ts';
import { Result } from '../../domain/result.ts';
import type { SprintId } from '../../domain/values/sprint-id.ts';
import type { ConfigStorePort } from './config-store-port.ts';

/** Inputs to {@link SetCurrentSprintUseCase}. */
export interface SetCurrentSprintInput {
  readonly id: SprintId | null;
}

export class SetCurrentSprintUseCase {
  constructor(
    private readonly sprints: SprintRepository,
    private readonly configStore: ConfigStorePort
  ) {}

  async execute(input: SetCurrentSprintInput): Promise<Result<void, DomainError>> {
    if (input.id !== null) {
      const found = await this.sprints.findById(input.id);
      if (!found.ok) return Result.error(found.error);
    }
    const loaded = await this.configStore.load();
    if (!loaded.ok) return Result.error(loaded.error);
    const saved = await this.configStore.save({ ...loaded.value, currentSprint: input.id });
    if (!saved.ok) return Result.error(saved.error);
    return Result.ok();
  }
}
