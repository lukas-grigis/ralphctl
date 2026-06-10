import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Record that a blocked task's rejected working-tree diff was quarantined to a git stash, so the
 * operator can recover it later via `git stash list`.
 *
 * Context — the serial dirty-tree contamination bug: a task that settles `blocked` (verify-failed
 * self-block) deliberately leaves its rejected diff in the SHARED worktree (the settle guardrail
 * exempts the block path). On the serial implement path nothing cleans the tree between tasks, so
 * the NEXT task's `git add -A` commit swept the prior task's rejected diff into its own commit —
 * and the contamination flipped the next task's pre-verify red, which `post-task-verify` then
 * mis-attributed to a broken baseline (no block set), landing a corrupt commit on a red tree. The
 * quarantine leaf stashes that diff so the tree IS clean again before the next task runs; this use
 * case persists a pointer to the stash onto the just-blocked task so the operator knows where the
 * rejected work went.
 *
 * The pointer is the deterministic stash MESSAGE (`ralphctl/<sprintId>/<taskId>/blocked-diff`), not
 * a `stash@{0}` ref: the ref is positional and goes stale the instant any other stash is pushed (a
 * sibling task's preflight stash, operator activity), whereas the message is a stable, greppable
 * handle that `git stash list` prints verbatim. We append a recovery line to `blockedReason` rather
 * than adding a Task field — the block reason is already the operator-facing carrier for "why this
 * task is stuck and what to do," and the domain Task entity stays unchanged.
 *
 * Idempotent on the reason text: re-recording the same stash message is a no-op (the line already
 * present is not duplicated), so a relaunch that re-quarantines a clean tree never compounds the
 * reason.
 *
 * Only a `blocked` task can carry a quarantine pointer — a non-blocked task is a programmer error
 * (the leaf guards on status before calling this), surfaced as an `InvalidStateError`.
 */
export interface RecordQuarantineProps {
  readonly task: BlockedTask;
  readonly sprintId: SprintId;
  /** Deterministic stash message the quarantine leaf pushed under — the recovery handle. */
  readonly stashMessage: string;
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
}

export type RecordQuarantineOutput = BlockedTask;

/** Marker that prefixes the appended recovery line so re-records are idempotent and greppable. */
const QUARANTINE_LINE_PREFIX = 'Rejected diff quarantined to git stash';

const buildReason = (current: string, stashMessage: string): string => {
  const line = `${QUARANTINE_LINE_PREFIX} (recover via \`git stash list\`): ${stashMessage}`;
  // Idempotent: if this exact recovery line is already present (relaunch re-quarantine), keep the
  // reason byte-for-byte so repeated runs don't stack duplicate lines.
  if (current.includes(line)) return current;
  return `${current}\n${line}`;
};

export const recordQuarantineUseCase = async (
  props: RecordQuarantineProps
): Promise<Result<RecordQuarantineOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const log = props.logger.named('task.record-quarantine');

  // Defensive: the leaf only calls this for a settled `blocked` task. A non-blocked task here is a
  // ctx-shape bug upstream — surface it as an InvalidStateError rather than silently mutating.
  if (props.task.status !== 'blocked') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: (props.task as { status: string }).status,
        attemptedAction: 'record-quarantine',
        message: `record-quarantine: expected a blocked task — got '${(props.task as { status: string }).status}'`,
      })
    );
  }

  const nextReason = buildReason(props.task.blockedReason, props.stashMessage);
  if (nextReason === props.task.blockedReason) {
    log.debug('quarantine pointer already recorded; skipping re-write', {
      taskId: props.task.id,
      sprintId: props.sprintId,
    });
    return Result.ok(props.task);
  }

  const updated: BlockedTask = { ...props.task, blockedReason: nextReason };
  const persisted = await props.taskRepo.update(props.sprintId, updated);
  if (!persisted.ok) {
    log.error('persist failed', { taskId: updated.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info('recorded quarantine pointer on blocked task', {
    taskId: updated.id,
    sprintId: props.sprintId,
    stashMessage: props.stashMessage,
  });
  return Result.ok(updated);
};
