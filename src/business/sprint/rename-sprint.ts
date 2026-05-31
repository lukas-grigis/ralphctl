import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type OpenSprint, renameSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Rename a sprint. Domain `renameSprint` rejects done sprints (terminal/immutable) and
 * validates the new name. Persists on success.
 */
export interface RenameSprintProps {
  readonly sprint: Sprint;
  readonly newName: string;
  readonly sprintRepo: Save<Sprint>;
  readonly logger: Logger;
}

export const renameSprintUseCase = async (
  props: RenameSprintProps
): Promise<Result<OpenSprint, ValidationError | InvalidStateError | StorageError>> => {
  const log = props.logger.named('sprint.rename');
  log.debug('renaming sprint', { sprintId: props.sprint.id, from: props.sprint.name, to: props.newName });

  const renamed = renameSprint(props.sprint, props.newName);
  if (!renamed.ok) {
    log.warn('renameSprint failed', { sprintId: props.sprint.id, error: renamed.error.message });
    return Result.error(renamed.error);
  }

  const persisted = await props.sprintRepo.save(renamed.value);
  if (!persisted.ok) {
    log.error('save failed', { sprintId: renamed.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`renamed sprint to '${renamed.value.name}'`, { sprintId: renamed.value.id });
  return Result.ok(renamed.value);
};
