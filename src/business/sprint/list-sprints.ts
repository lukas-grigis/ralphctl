import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Enumerate all sprints. The TUI sprint-picker filters this list by project; pushing the
 * filter into the repository would tie the storage layer to project knowledge, which the
 * `Sprint` aggregate already encodes via `projectId`.
 */
export interface ListSprintsProps {
  readonly sprintRepo: ListAll<Sprint>;
  readonly logger: Logger;
}

export const listSprintsUseCase = async (props: ListSprintsProps): Promise<Result<readonly Sprint[], StorageError>> => {
  const log = props.logger.named('sprint.list');
  log.debug('listing sprints');

  const result = await props.sprintRepo.list();
  if (!result.ok) {
    log.error('list failed', { error: result.error.message });
    return Result.error(result.error);
  }
  log.debug(`loaded ${String(result.value.length)} sprint(s)`, { count: result.value.length });
  return Result.ok(result.value);
};
