import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { createProject, type Project, type ProjectCreateInput } from '@src/domain/entity/project.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Build a fresh `Project` and persist it. Logging happens at the use-case boundary so the TUI
 * "creating project…" view doesn't need to know what `createProject` validates internally.
 *
 * Domain validation (name non-empty, slug shape, ai cwd existence) lives in `createProject`;
 * this use case forwards those `ValidationError`s. Persistence failures surface as `StorageError`.
 */
export interface CreateProjectProps {
  readonly input: ProjectCreateInput;
  readonly projectRepo: Save<Project>;
  readonly logger: Logger;
}

export const createProjectUseCase = async (
  props: CreateProjectProps
): Promise<Result<Project, ValidationError | StorageError>> => {
  const log = props.logger.named('project.create');
  log.debug('creating project', { name: props.input.displayName });

  const created = createProject(props.input);
  if (!created.ok) {
    log.warn('validation failed', { name: props.input.displayName, error: created.error.message });
    return Result.error(created.error);
  }

  const persisted = await props.projectRepo.save(created.value);
  if (!persisted.ok) {
    log.error('save failed', { projectId: created.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`created project '${created.value.displayName}'`, { projectId: created.value.id });
  return Result.ok(created.value);
};
