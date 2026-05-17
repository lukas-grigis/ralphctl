import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Enumerate all projects. Thin wrapper around `projectRepo.list()` with named logging.
 * UUIDv7 ids are lex-sortable so callers wanting "most recent N" can sort + slice; no
 * separate pagination capability needed (see `ListAll` docs).
 */
export interface ListProjectsProps {
  readonly projectRepo: ListAll<Project>;
  readonly logger: Logger;
}

export const listProjectsUseCase = async (
  props: ListProjectsProps
): Promise<Result<readonly Project[], StorageError>> => {
  const log = props.logger.named('project.list');
  log.debug('listing projects');

  const result = await props.projectRepo.list();
  if (!result.ok) {
    log.error('list failed', { error: result.error.message });
    return Result.error(result.error);
  }
  log.debug(`loaded ${String(result.value.length)} project(s)`, { count: result.value.length });
  return Result.ok(result.value);
};
