import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { activateSprint as activateSprintEntity, type ActiveSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Transition a sprint from `planned` to `active`. Idempotent — an already-`active` sprint passes
 * through unchanged so the implement chain can re-run safely.
 *
 * Single-active-per-project invariant: before transitioning, scans existing sprints for the same
 * `projectId` and rejects with `ConflictError` if another sprint is already `active` or `review`
 * (both states hold the sprint branch checked out — running two implement loops on one project
 * would race on the working tree). The user must close the colliding sprint first.
 *
 * Policy: domain transition + persist + log. Pure orchestration; the chain leaf adapts ctx → props
 * → ctx and supplies deps.
 */
export interface ActivateSprintProps {
  readonly sprint: Sprint;
  readonly sprintRepo: Save<Sprint> & ListAll<Sprint>;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export type ActivateSprintOutput = ActiveSprint;

export const activateSprintUseCase = async (
  props: ActivateSprintProps
): Promise<Result<ActivateSprintOutput, InvalidStateError | ConflictError | StorageError>> => {
  const log = props.logger.named('sprint.activate');

  if (props.sprint.status === 'active') {
    log.debug('already active, skipping', { sprintId: props.sprint.id });
    return Result.ok(props.sprint as ActiveSprint);
  }

  const conflictCheck = await assertNoActivePeer(props.sprint, props.sprintRepo, log);
  if (!conflictCheck.ok) return Result.error(conflictCheck.error);

  log.debug('activating sprint', { sprintId: props.sprint.id, from: props.sprint.status });

  const transitioned = activateSprintEntity(props.sprint, props.clock());
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

  log.info(`activated sprint '${transitioned.value.slug}'`, {
    sprintId: transitioned.value.id,
    activatedAt: transitioned.value.activatedAt,
  });
  return Result.ok(transitioned.value);
};

const assertNoActivePeer = async (
  candidate: Sprint,
  sprints: ListAll<Sprint>,
  log: Logger
): Promise<Result<undefined, ConflictError | StorageError>> => {
  const all = await sprints.list();
  if (!all.ok) return Result.error(all.error);

  const peer = all.value.find(
    (s) =>
      s.id !== candidate.id && s.projectId === candidate.projectId && (s.status === 'active' || s.status === 'review')
  );
  if (peer === undefined) return Result.ok(undefined);

  log.warn('refusing to activate: another sprint already holds the project', {
    candidateId: candidate.id,
    peerId: peer.id,
    peerStatus: peer.status,
    projectId: candidate.projectId,
  });
  return Result.error(
    new ConflictError({
      entity: 'sprint',
      field: 'projectId',
      value: String(candidate.projectId),
      message: `cannot activate sprint '${String(candidate.slug)}': sprint '${String(peer.slug)}' is already ${peer.status} in this project`,
      hint: `close sprint '${String(peer.slug)}' first ('ralphctl sprint close ${String(peer.id)}' once it's in review)`,
    })
  );
};
