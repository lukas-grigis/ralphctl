import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Load a project by id. Thin wrapper over `projectRepo.findById` that adds named logging so
 * call-sites get a structured `[project.find]` trace entry without each TUI view rolling its
 * own log line.
 */
export interface FindProjectProps {
  readonly id: ProjectId;
  readonly projectRepo: FindById<Project, ProjectId>;
  readonly logger: Logger;
}

export const findProjectUseCase = async (
  props: FindProjectProps
): Promise<Result<Project, NotFoundError | StorageError>> => {
  const log = props.logger.named('project.find');
  log.debug('loading project', { projectId: props.id });

  const result = await props.projectRepo.findById(props.id);
  if (!result.ok) {
    log.warn('project lookup failed', { projectId: props.id, error: result.error.message });
    return Result.error(result.error);
  }
  log.debug(`loaded project '${result.value.displayName}'`, { projectId: result.value.id });
  return Result.ok(result.value);
};
