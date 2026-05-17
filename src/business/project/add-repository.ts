import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { addRepository, type Project } from '@src/domain/entity/project.ts';
import { createRepository, type Repository, type RepositoryCreateInput } from '@src/domain/entity/repository.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Build a fresh `Repository` and append it to its project. Two domain calls in one use case
 * because the leaf would otherwise need to know how to construct the entity AND wire it onto
 * the project — the composition is small but business-y.
 */
export interface AddRepositoryProps {
  readonly project: Project;
  readonly input: RepositoryCreateInput;
  readonly projectRepo: Save<Project>;
  readonly logger: Logger;
}

export interface AddRepositoryOutput {
  readonly project: Project;
  readonly repository: Repository;
}

export const addRepositoryUseCase = async (
  props: AddRepositoryProps
): Promise<Result<AddRepositoryOutput, ValidationError | ConflictError | StorageError>> => {
  const log = props.logger.named('project.add-repository');
  log.debug('adding repository to project', { projectId: props.project.id, slug: props.input.slug });

  const created = createRepository(props.input);
  if (!created.ok) {
    log.warn('repository validation failed', { projectId: props.project.id, error: created.error.message });
    return Result.error(created.error);
  }

  const updated = addRepository(props.project, created.value);
  if (!updated.ok) {
    log.warn('addRepository failed', {
      projectId: props.project.id,
      repositoryId: created.value.id,
      error: updated.error.message,
    });
    return Result.error(updated.error);
  }

  const persisted = await props.projectRepo.save(updated.value);
  if (!persisted.ok) {
    log.error('save failed', { projectId: updated.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`added repository '${String(created.value.slug)}'`, {
    projectId: updated.value.id,
    repositoryId: created.value.id,
    slug: String(created.value.slug),
  });
  return Result.ok({ project: updated.value, repository: created.value });
};
