import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AttemptWarning } from '@src/domain/entity/attempt.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { BlockedTask, DoneTask, InProgressTask } from '@src/domain/entity/task.ts';
import { recordRunningAttemptWarning } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt, markTaskDone } from '@src/domain/entity/task-settle.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Settle a running attempt at the end of one gen-eval loop. The locked policy
 * (see {@link AttemptWarning} in `domain/entity/attempt.ts`) is:
 *
 *   `blockedReason` set                       → mark task blocked
 *                                               (running attempt settled as aborted first)
 *   any verdict, no blockedReason             → mark task done
 *
 * `verdict` is captured for logging and audit only — the inner-loop policy already collapsed
 * the four non-pass termination kinds (`failed` / `malformed` / `plateau` / `budget-exhausted`
 * → `markTaskDone` + structured warning, `self-blocked` → `markTaskBlocked`) inside
 * `finalize-gen-eval`. The optional `warning` is stamped onto the running attempt before the
 * task transitions so attempt history carries the failure-mode for review tooling.
 *
 * Why "done with warning" instead of "retry the attempt": v2 runs ONE attempt per task; retry
 * is the inner gen-eval loop's job (turns bounded by `maxTurns`). When the loop terminates
 * without a passing verdict the operator inspects the warning and decides whether to redo the
 * task — the harness does not auto-retry.
 */
export type SettleVerdict = 'passed' | 'failed' | 'malformed';

export interface SettleAttemptProps {
  readonly task: InProgressTask;
  readonly sprintId: SprintId;
  readonly verdict: SettleVerdict;
  readonly blockedReason?: string;
  readonly warning?: AttemptWarning;
  /**
   * Fail the current running attempt instead of marking the task `done`. Set by the escalation
   * policy when a plateau triggered a once-per-task generator-model upgrade — the attempt's
   * critique stays useful but the task must stay `in_progress` so the next chain invocation
   * picks it up with the escalated model. When the running attempt count then reaches
   * `task.maxAttempts`, `failCurrentAttempt` itself transitions the task to `blocked`. Ignored
   * when `blockedReason` is set (the block path already settles the attempt as aborted).
   */
  readonly shouldFailAttempt?: boolean;
  readonly taskRepo: UpdateTask;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
  /**
   * Worktree-clean guardrail. Settle refuses to mark a task `done` when this returns `true` —
   * a dirty tree at settle time means commit-task either silently skipped or the AI created
   * untracked files after the commit ran. Either way, "done" would lie about what landed in
   * git. Optional so tests can opt out; production wires it from the implement chain's git
   * runner against the task's cwd.
   */
  readonly hasUncommittedChanges?: () => Promise<Result<boolean, StorageError>>;
  /** Used only in error messages so the operator knows which worktree to inspect. */
  readonly cwd?: AbsolutePath;
}

export type SettleAttemptOutput = DoneTask | InProgressTask | BlockedTask;

const settleTask = (
  props: Pick<SettleAttemptProps, 'task' | 'warning' | 'blockedReason' | 'shouldFailAttempt'>,
  now: IsoTimestamp
): Result<DoneTask | InProgressTask | BlockedTask, InvalidStateError> => {
  let task: InProgressTask = props.task;
  if (props.warning !== undefined) {
    const stamped = recordRunningAttemptWarning(task, props.warning);
    if (!stamped.ok) return Result.error(stamped.error);
    task = stamped.value;
  }
  if (props.blockedReason !== undefined) {
    const aborted = failCurrentAttempt(task, now, 'aborted');
    if (!aborted.ok) return Result.error(aborted.error);
    // A self-block (the generator emitted `<task-blocked>`) is an own-failure block — the operator
    // must address the blocker; it never cascade-clears via the upstream-unblock path.
    if (aborted.value.status === 'blocked') {
      return Result.ok({ ...aborted.value, blockedReason: props.blockedReason, blockKind: 'own' });
    }
    return markTaskBlocked(aborted.value, props.blockedReason, 'own');
  }
  if (props.shouldFailAttempt === true) {
    // Escalation path: settle the running attempt as failed but keep the task `in_progress`
    // (or transition to `blocked` if the running attempt count just hit `maxAttempts`). The
    // next chain invocation re-attempts the task with the escalated generator model.
    return failCurrentAttempt(task, now, 'failed');
  }
  return markTaskDone(task, now);
};

export const settleAttemptUseCase = async (
  props: SettleAttemptProps
): Promise<Result<SettleAttemptOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const log = props.logger.named('task.settle-attempt');
  log.debug('settling running attempt', {
    taskId: props.task.id,
    verdict: props.verdict,
    ...(props.blockedReason !== undefined ? { blockedReason: props.blockedReason } : {}),
    ...(props.warning !== undefined ? { warning: props.warning.kind } : {}),
  });

  // Guardrail: if we're about to mark the task `done` but the worktree is dirty, refuse.
  // A dirty tree at this point means commit-task didn't capture every change — usually
  // because the AI wrote files (or touched .gitignored paths that became tracked) after
  // commit ran. Marking "done" would lie about what's in git. The block + shouldFailAttempt
  // paths are exempt: self-blocked and escalation-retry tasks are allowed to leave changes
  // in place for the operator to inspect or the next attempt to consume.
  if (
    props.blockedReason === undefined &&
    props.shouldFailAttempt !== true &&
    props.hasUncommittedChanges !== undefined
  ) {
    const dirty = await props.hasUncommittedChanges();
    if (!dirty.ok) {
      log.error('settle: worktree status check failed', {
        taskId: props.task.id,
        error: dirty.error.message,
      });
      return Result.error(dirty.error);
    }
    if (dirty.value) {
      const cwdHint = props.cwd !== undefined ? ` in '${String(props.cwd)}'` : '';
      const message = `cannot settle task '${props.task.id}' as done: worktree${cwdHint} has uncommitted changes; the commit-task leaf must have failed or the AI wrote files after committing`;
      log.error(message, { taskId: props.task.id, verdict: props.verdict });
      return Result.error(
        new StorageError({
          subCode: 'io',
          message,
          hint: 'Inspect the diff in the task worktree, fix the cause (e.g. commit-message hook, untracked files), then rerun the sprint. The task remains in_progress.',
        })
      );
    }
  }

  const settled = settleTask(props, props.clock());
  if (!settled.ok) {
    log.warn('settle failed', { taskId: props.task.id, error: settled.error.message });
    return Result.error(settled.error);
  }

  const persisted = await props.taskRepo.update(props.sprintId, settled.value);
  if (!persisted.ok) {
    log.error('persist failed', { taskId: settled.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`settled task → ${settled.value.status}`, {
    taskId: props.task.id,
    verdict: props.verdict,
    finalStatus: settled.value.status,
    ...(props.blockedReason !== undefined ? { blockedReason: props.blockedReason } : {}),
  });
  return Result.ok(settled.value);
};
