import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { reopenDoneSprint, type ReviewSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { assertNoActivePeer } from '@src/business/sprint/assert-no-active-peer.ts';
import type { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Transition a sprint from `done` back to `review` — the recovery counterpart to
 * `transitionSprintToDoneUseCase`, and the one deliberate exit from an otherwise-terminal `done`
 * sprint. Idempotent — an already-`review` sprint passes through unchanged (mirrors
 * {@link activateSprintUseCase}'s shape), so a retried caller does not error on a sprint someone
 * else already reopened.
 *
 * Deliberately lands in `review`, not `active`: `revertSprintToActive` already owns the
 * review → active step, so a caller reopening runnable work after a close chains this use case
 * with that EXISTING one rather than a sprint gaining a second, parallel done → active transition
 * to keep in sync with it. Today's only caller is the CLI `sprint reopen` action
 * (`reopenSprintAction`); `unblockTaskUseCase`'s own `done → review` hop calls the domain
 * `reopenDoneSprint` transition directly and persists through its own logging, so it does NOT
 * route through this use case (and, notably, does not get the peer check below for free).
 *
 * Single-active-per-project invariant: `review` is one of the two states (with `active`) that
 * hold the sprint branch checked out, so reopening a `done` sprint back into `review` is subject
 * to the SAME invariant {@link activateSprintUseCase} enforces — otherwise a closed sprint could
 * be pulled back in alongside a live peer, and the two would not mutually exclude on the shared
 * working tree (the repo lock is keyed per sprint dir, not per project). Enforced via the shared
 * {@link assertNoActivePeer}.
 *
 * Policy: domain transition + persist + log. Pure orchestration; the same shape as its sibling
 * sprint use cases.
 */
export interface ReopenDoneSprintProps {
  readonly sprint: Sprint;
  readonly sprintRepo: Save<Sprint> & ListAll<Sprint>;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export type ReopenDoneSprintOutput = ReviewSprint;

export const reopenDoneSprintUseCase = async (
  props: ReopenDoneSprintProps
): Promise<Result<ReopenDoneSprintOutput, InvalidStateError | ConflictError | StorageError>> => {
  const log = props.logger.named('sprint.reopen-done');

  if (props.sprint.status === 'review') {
    log.debug('already review, skipping', { sprintId: props.sprint.id });
    return Result.ok(props.sprint as ReviewSprint);
  }

  const conflictCheck = await assertNoActivePeer(props.sprint, props.sprintRepo, log, 'reopen');
  if (!conflictCheck.ok) return Result.error(conflictCheck.error);

  log.debug('reopening sprint', { sprintId: props.sprint.id, from: props.sprint.status });

  const transitioned = reopenDoneSprint(props.sprint, props.clock());
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

  log.info(`reopened sprint '${transitioned.value.slug}' done → review`, {
    sprintId: transitioned.value.id,
    reviewAt: transitioned.value.reviewAt,
  });
  return Result.ok(transitioned.value);
};
