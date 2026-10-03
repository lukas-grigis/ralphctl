import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { runActiveRefusal, type RunActivityProbe } from '@src/business/_shared/run-activity-probe.ts';

/**
 * Remove a sprint by id — its directory holds the sprint, its execution record and its tasks. Refuses while a flow
 * run is active, since a running flow may hold this sprint's paths.
 */
export interface DeleteSprintProps {
  readonly id: SprintId;
  readonly sprintRepo: Remove<SprintId>;
  readonly runActivity: RunActivityProbe;
  readonly logger: Logger;
}

export const deleteSprintUseCase = async (
  props: DeleteSprintProps
): Promise<Result<void, NotFoundError | StorageError | InvalidStateError>> => {
  const log = props.logger.named('sprint.delete');
  if (await props.runActivity.anyRunActive()) {
    log.warn('delete refused — a flow is running', { sprintId: props.id });
    return Result.error(runActiveRefusal('remove sprint'));
  }
  log.debug('deleting sprint', { sprintId: props.id });

  const removed = await props.sprintRepo.remove(props.id);
  if (!removed.ok) {
    log.warn('delete failed', { sprintId: props.id, error: removed.error.message });
    return Result.error(removed.error);
  }

  log.info('deleted sprint', { sprintId: props.id });
  return Result.ok(undefined);
};
