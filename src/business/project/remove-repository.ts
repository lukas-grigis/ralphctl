import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type Project, removeRepository } from '@src/domain/entity/project.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Remove a repository from its project. Domain `removeRepository` rejects removing the last
 * repository of a project. Persists the trimmed project on success.
 */
export interface RemoveRepositoryProps {
  readonly project: Project;
  readonly repositoryId: RepositoryId;
  readonly projectRepo: Save<Project>;
  readonly logger: Logger;
}

export const removeRepositoryUseCase = async (
  props: RemoveRepositoryProps
): Promise<Result<Project, ValidationError | StorageError>> => {
  const log = props.logger.named('project.remove-repository');
  log.debug('removing repository from project', {
    projectId: props.project.id,
    repositoryId: props.repositoryId,
  });

  const updated = removeRepository(props.project, props.repositoryId);
  if (!updated.ok) {
    log.warn('removeRepository failed', {
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

  log.info('removed repository', { projectId: updated.value.id, repositoryId: props.repositoryId });
  return Result.ok(updated.value);
};
