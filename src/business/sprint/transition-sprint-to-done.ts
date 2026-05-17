import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { transitionSprintToDone, type DoneSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Transition a sprint from `review` to `done`. The `aborted` flag (user cancelled mid-review)
 * short-circuits the transition — the sprint stays in `review` for a subsequent invocation to
 * pick up. Returns `undefined` for the aborted case so the chain leaf can skip the ctx update.
 */
export interface TransitionSprintToDoneProps {
  readonly sprint: Sprint;
  readonly aborted: boolean;
  readonly sprintRepo: Save<Sprint>;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export type TransitionSprintToDoneOutput = DoneSprint | undefined;

export const transitionSprintToDoneUseCase = async (
  props: TransitionSprintToDoneProps
): Promise<Result<TransitionSprintToDoneOutput, InvalidStateError | StorageError>> => {
  const log = props.logger.named('sprint.transition-to-done');

  if (props.aborted) {
    log.debug('user aborted review, leaving sprint in review', { sprintId: props.sprint.id });
    return Result.ok(undefined);
  }

  log.debug('transitioning sprint to done', { sprintId: props.sprint.id, from: props.sprint.status });

  const transitioned = transitionSprintToDone(props.sprint, props.clock());
  if (!transitioned.ok) {
    log.warn('invalid state transition', {
      sprintId: props.sprint.id,
      from: props.sprint.status,
      error: transitioned.error.message,
    });
    return Result.error(transitioned.error);
  }

  const persisted = await props.sprintRepo.save(transitioned.value);
  if (!persisted.ok) {
    log.error('save failed', { sprintId: transitioned.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`sprint '${transitioned.value.slug}' → done`, {
    sprintId: transitioned.value.id,
    doneAt: transitioned.value.doneAt,
  });
  return Result.ok(transitioned.value);
};
