import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** Load a sprint by id. Thin wrapper over `sprintRepo.findById` with named logging. */
export interface FindSprintProps {
  readonly id: SprintId;
  readonly sprintRepo: FindById<Sprint, SprintId>;
  readonly logger: Logger;
}

export const findSprintUseCase = async (
  props: FindSprintProps
): Promise<Result<Sprint, NotFoundError | StorageError>> => {
  const log = props.logger.named('sprint.find');
  log.debug('loading sprint', { sprintId: props.id });

  const result = await props.sprintRepo.findById(props.id);
  if (!result.ok) {
    log.warn('sprint lookup failed', { sprintId: props.id, error: result.error.message });
    return Result.error(result.error);
  }
  log.debug(`loaded sprint '${result.value.name}'`, { sprintId: result.value.id, status: result.value.status });
  return Result.ok(result.value);
};
