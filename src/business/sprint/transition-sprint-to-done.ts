import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { type Sprint, transitionSprintToDone } from '@src/domain/entity/sprint.ts';
import type { UpdateSprint } from '@src/domain/repository/sprint/update-sprint.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Transition a sprint from `review` to `done`. The `aborted` flag (user cancelled mid-review)
 * short-circuits the transition — the sprint stays in `review` for a subsequent invocation to
 * pick up. Returns `undefined` for the aborted case so the chain leaf can skip the ctx update.
 *
 * The transition applies to the sprint as it is on disk now (a locked `update`), not to the copy
 * the flow loaded at its start: close and review hold that copy across prompts and AI steps while
 * ticket writers may still edit `sprint.json`.
 */
export interface TransitionSprintToDoneProps {
  readonly sprint: Sprint;
  readonly aborted: boolean;
  readonly sprintRepo: UpdateSprint;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

/** The `done` sprint as persisted; `undefined` when aborted. */
export type TransitionSprintToDoneOutput = Sprint | undefined;

export const transitionSprintToDoneUseCase = async (
  props: TransitionSprintToDoneProps
): Promise<Result<TransitionSprintToDoneOutput, DomainError>> => {
  const log = props.logger.named('sprint.transition-to-done');

  if (props.aborted) {
    log.debug('user aborted review, leaving sprint in review', { sprintId: props.sprint.id });
    return Result.ok(undefined);
  }

  log.debug('transitioning sprint to done', { sprintId: props.sprint.id, from: props.sprint.status });

  const persisted = await props.sprintRepo.update(props.sprint.id, (fresh) =>
    transitionSprintToDone(fresh, props.clock())
  );
  if (!persisted.ok) {
    log.warn('transition to done failed', { sprintId: props.sprint.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`sprint '${persisted.value.slug}' → done`, { sprintId: persisted.value.id });
  return Result.ok(persisted.value);
};
