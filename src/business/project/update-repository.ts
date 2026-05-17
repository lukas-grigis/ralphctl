import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { updateRepository, type Project, type RepositoryUpdate } from '@src/domain/entity/project.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Patch a repository on its project. Domain `updateRepository` validates the patch, applies it,
 * and re-checks project-scoped invariants (e.g. slug uniqueness). Persistence on success.
 */
export interface UpdateRepositoryProps {
  readonly project: Project;
  readonly repositoryId: RepositoryId;
  readonly patch: RepositoryUpdate;
  readonly projectRepo: Save<Project>;
  readonly logger: Logger;
}

export const updateRepositoryUseCase = async (
  props: UpdateRepositoryProps
): Promise<Result<Project, ValidationError | ConflictError | NotFoundError | StorageError>> => {
  const log = props.logger.named('project.update-repository');
  log.debug('updating repository', { projectId: props.project.id, repositoryId: props.repositoryId });

  const updated = updateRepository(props.project, props.repositoryId, props.patch);
  if (!updated.ok) {
    log.warn('updateRepository failed', {
      projectId: props.project.id,
      repositoryId: props.repositoryId,
      error: updated.error.message,
    });
    return Result.error(updated.error);
  }

  const persisted = await props.projectRepo.save(updated.value);
  if (!persisted.ok) {
    log.error('save failed', { projectId: updated.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info('updated repository', { projectId: updated.value.id, repositoryId: props.repositoryId });
  return Result.ok(updated.value);
};
