import type { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { RunActivityProbe } from '@src/business/_shared/run-activity-probe.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import { deleteSprintUseCase } from '@src/business/sprint/delete-sprint.ts';

export interface DeleteSprintDeps {
  readonly sprintRepo: Remove<SprintId>;
  readonly runActivity: RunActivityProbe;
  readonly logger: Logger;
}

/** Single-sprint removal for the TUI and CLI; refuses while a flow run is active. */
export interface SprintRemoval {
  remove(sprintId: SprintId): Promise<Result<void, NotFoundError | StorageError | InvalidStateError>>;
}

export const createSprintRemoval = (deps: DeleteSprintDeps): SprintRemoval => ({
  remove: (id) => deleteSprintUseCase({ id, ...deps }),
});
