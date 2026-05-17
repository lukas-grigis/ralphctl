import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Remove a sprint by id. Does not cascade to tasks or the paired sprint-execution — those are
 * separate aggregates and a wider clean-up belongs in a delete-sprint meta-flow.
 */
export interface DeleteSprintProps {
  readonly id: SprintId;
  readonly sprintRepo: Remove<SprintId>;
  readonly logger: Logger;
}

export const deleteSprintUseCase = async (
  props: DeleteSprintProps
): Promise<Result<void, NotFoundError | StorageError>> => {
  const log = props.logger.named('sprint.delete');
  log.debug('deleting sprint', { sprintId: props.id });

  const removed = await props.sprintRepo.remove(props.id);
  if (!removed.ok) {
    log.warn('delete failed', { sprintId: props.id, error: removed.error.message });
    return Result.error(removed.error);
  }

  log.info('deleted sprint', { sprintId: props.id });
  return Result.ok(undefined);
};
