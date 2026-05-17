import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { createSprintWithExecution, type DraftSprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Build a fresh draft sprint and its paired `SprintExecution`. Pure: no I/O. The chain leaf
 * wraps this with persistence (`saveSprintLeaf` + `saveSprintExecutionLeaf`); callers that
 * bypass the chain are responsible for atomic persistence themselves.
 */
export interface CreateSprintProps {
  readonly projectId: ProjectId;
  readonly name: string;
  /** Optional. Defaults to `kebab-case(name)` inside `createSprintWithExecution`. */
  readonly slug?: Slug;
  readonly logger: Logger;
}

export interface CreateSprintOutput {
  readonly sprint: DraftSprint;
  readonly execution: SprintExecution;
}

export const createSprintUseCase = (props: CreateSprintProps): Result<CreateSprintOutput, ValidationError> => {
  const log = props.logger.named('sprint.create');
  log.debug('creating sprint', { projectId: props.projectId, name: props.name });

  const created = createSprintWithExecution({
    name: props.name,
    ...(props.slug !== undefined ? { slug: props.slug } : {}),
    projectId: props.projectId,
  });
  if (!created.ok) {
    log.warn('validation failed', { name: props.name, error: created.error.message });
    return Result.error(created.error);
  }

  log.info(`created sprint '${created.value.sprint.slug}'`, {
    sprintId: created.value.sprint.id,
    projectId: props.projectId,
  });
  return Result.ok({ sprint: created.value.sprint, execution: created.value.execution });
};
