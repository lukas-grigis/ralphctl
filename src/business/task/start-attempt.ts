import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FindTaskById } from '@src/domain/repository/task/find-task-by-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Start a fresh `running` attempt on a task and persist the transition. Domain transition +
 * single-task repo update + log. The chain leaf adapts ctx → props → ctx.
 *
 * Resume semantics: if the task is already `in_progress` with a leftover `running` attempt
 * from a prior aborted chain (e.g. the user hit Ctrl+C or the host crashed mid-task), the
 * use case settles that attempt as `aborted` first, then opens a fresh attempt. This makes
 * the next Implement launch a transparent resume — no manual cleanup required.
 *
 * Returns `BlockedTask` indirectly: when settling the prior attempt as aborted pushes the
 * task over `maxAttempts`, the domain transitions it to `blocked` and we surface that as a
 * state error so the chain doesn't try to start an attempt on a blocked task.
 */
export interface StartAttemptProps {
  readonly task: Task;
  readonly sprintId: SprintId;
  readonly taskRepo: UpdateTask & FindTaskById;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export type StartAttemptOutput = InProgressTask;

const hasRunningAttempt = (task: Task): boolean => task.attempts.at(-1)?.status === 'running';

export const startAttemptUseCase = async (
  props: StartAttemptProps
): Promise<Result<StartAttemptOutput, InvalidStateError | NotFoundError | StorageError | ValidationError>> => {
  const log = props.logger.named('task.start-attempt');
  log.debug('starting next attempt', {
    taskId: props.task.id,
    sprintId: props.sprintId,
    currentStatus: props.task.status,
    priorAttempts: props.task.attempts.length,
  });

  // Resume path: a prior chain left a `running` attempt behind. Settle it as `aborted` before
  // appending a new one so the domain invariant ("only one running attempt at a time") holds.
  let taskToStart: Task = props.task;
  let recovering: RecoveryContext | undefined;
  if (props.task.status === 'in_progress' && hasRunningAttempt(props.task)) {
    // Divergence guard: re-read the task from the repo and compare against the in-memory
    // copy before settling. A stale in-memory cache (e.g. another concurrent operation wrote
    // a new attempt or the operator manually patched tasks.json) would otherwise be silently
    // overwritten by our update, losing whichever change is newer. We compare the cheap
    // discriminators — status + attempt count + last-attempt status — which catch every
    // realistic divergence without serialising the whole object.
    const fresh = await props.taskRepo.findById(props.sprintId, props.task.id);
    if (!fresh.ok) {
      log.warn('resume: could not re-read task for divergence check', {
        taskId: props.task.id,
        error: fresh.error.message,
      });
      return Result.error(fresh.error);
    }
    const stale = fresh.value;
    const inMemoryLastAttempt = props.task.attempts.at(-1);
    const persistedLastAttempt = stale.attempts.at(-1);
    // Including last-attempt startedAt catches the rare race where another writer replaced the
    // running attempt with one of the same n + status (e.g. a different process restarted the
    // attempt) — the timestamps will differ even when status/length collide.
    if (
      stale.status !== props.task.status ||
      stale.attempts.length !== props.task.attempts.length ||
      persistedLastAttempt?.status !== inMemoryLastAttempt?.status ||
      persistedLastAttempt?.startedAt !== inMemoryLastAttempt?.startedAt
    ) {
      log.warn('resume: in-memory task diverges from persisted state — refusing to overwrite', {
        taskId: props.task.id,
        inMemoryStatus: props.task.status,
        persistedStatus: stale.status,
        inMemoryAttempts: props.task.attempts.length,
        persistedAttempts: stale.attempts.length,
        inMemoryLastStartedAt: inMemoryLastAttempt?.startedAt,
        persistedLastStartedAt: persistedLastAttempt?.startedAt,
      });
      return Result.error(
        new InvalidStateError({
          entity: 'task',
          currentState: stale.status,
          attemptedAction: 'resume-from-stale-cache',
          message: `task '${String(props.task.id)}' diverges between in-memory (${props.task.status}, ${String(props.task.attempts.length)} attempts) and persisted state (${stale.status}, ${String(stale.attempts.length)} attempts). Reload tasks and retry.`,
        })
      );
    }
    // Cause attribution on the cross-process resume path: we don't know what killed the
    // previous process (Ctrl-C, SIGTERM, idle-watchdog, v8 OOM all leave the same trace —
    // a leftover `running` attempt). `process-crash` is the conservative label; the
    // in-process abort path (P1j follow-up) will pass a richer cause via `failCurrentAttempt`.
    const priorAttemptN = props.task.attempts.length;
    const abortedAt = props.clock();
    log.info('recovering aborted attempt before resume', {
      taskId: props.task.id,
      priorAttemptN,
      cause: 'process-crash',
    });
    const aborted = failCurrentAttempt(props.task, abortedAt, 'aborted', { abortCause: 'process-crash' });
    if (!aborted.ok) {
      log.warn('failed to settle prior running attempt during resume', {
        taskId: props.task.id,
        error: aborted.error.message,
      });
      return Result.error(aborted.error);
    }
    if (aborted.value.status === 'blocked') {
      log.warn('task blocked after settling aborted attempt (attempt budget exhausted)', {
        taskId: aborted.value.id,
        blockedReason: aborted.value.blockedReason,
      });
      return Result.error(
        new InvalidStateError({
          entity: 'task',
          currentState: 'blocked',
          attemptedAction: 'start-attempt-after-resume',
          message: `task '${String(aborted.value.id)}' is blocked: ${aborted.value.blockedReason ?? 'unknown reason'}`,
        })
      );
    }
    taskToStart = aborted.value;
    recovering = { fromAttemptN: priorAttemptN, cause: 'process-crash', abortedAt };
  }

  const transitioned = startNextAttempt(taskToStart, props.clock(), undefined, recovering);
  if (!transitioned.ok) {
    log.warn('cannot start next attempt', { taskId: props.task.id, error: transitioned.error.message });
    return Result.error(transitioned.error);
  }

  // Persist the new running attempt. Note we don't persist the intermediate "aborted prior
  // attempt" state separately — `transitioned.value` already contains the settled prior
  // attempt plus the new running attempt, so one write captures both transitions atomically.
  const persisted = await props.taskRepo.update(props.sprintId, transitioned.value);
  if (!persisted.ok) {
    log.error('persist failed', { taskId: transitioned.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  const attemptN = transitioned.value.attempts.length;
  log.info(`started attempt n=${String(attemptN)}`, {
    taskId: transitioned.value.id,
    attemptN,
    name: transitioned.value.name,
  });
  return Result.ok(transitioned.value);
};
