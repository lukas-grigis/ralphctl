import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { transitionSprintToReview, type ReviewSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Transition a sprint from `active` to `review`. Called by the implement chain after every task
 * has settled (done or blocked). Domain transition + persist + log.
 */
export interface TransitionSprintToReviewProps {
  readonly sprint: Sprint;
  readonly sprintRepo: Save<Sprint>;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export type TransitionSprintToReviewOutput = ReviewSprint;

export const transitionSprintToReviewUseCase = async (
  props: TransitionSprintToReviewProps
): Promise<Result<TransitionSprintToReviewOutput, InvalidStateError | StorageError>> => {
  const log = props.logger.named('sprint.transition-to-review');
  log.debug('transitioning sprint to review', { sprintId: props.sprint.id, from: props.sprint.status });

  const transitioned = transitionSprintToReview(props.sprint, props.clock());
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

  log.info(`sprint '${transitioned.value.slug}' → review`, {
    sprintId: transitioned.value.id,
    reviewAt: transitioned.value.reviewAt,
  });
  return Result.ok(transitioned.value);
};
