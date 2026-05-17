import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Remove a project by id. Thin wrapper over `projectRepo.remove` with named logging.
 *
 * Caveat: this use case does NOT cascade — sprints / tasks tied to the project remain on
 * disk. Cascading deletes are a separate orchestration concern (a meta-flow) and pushing them
 * into a single use case would couple two aggregates here.
 */
export interface DeleteProjectProps {
  readonly id: ProjectId;
  readonly projectRepo: Remove<ProjectId>;
  readonly logger: Logger;
}

export const deleteProjectUseCase = async (
  props: DeleteProjectProps
): Promise<Result<void, NotFoundError | StorageError>> => {
  const log = props.logger.named('project.delete');
  log.debug('deleting project', { projectId: props.id });

  const removed = await props.projectRepo.remove(props.id);
  if (!removed.ok) {
    log.warn('delete failed', { projectId: props.id, error: removed.error.message });
    return Result.error(removed.error);
  }

  log.info(`deleted project`, { projectId: props.id });
  return Result.ok(undefined);
};
