import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FindTaskById } from '@src/domain/repository/task/find-task-by-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { BlockedTask, InProgressTask, Task } from '@src/domain/entity/task.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Conservative {@link AbortCause} for a leftover `running` attempt: a prior process exited without
 * settling it (Ctrl-C, SIGTERM, watchdog, OOM all leave the same trace), so we cannot attribute a
 * precise cause on the cross-process resume path.
 */
const PROCESS_CRASH_CAUSE = 'process-crash';

/**
 * Start a fresh `running` attempt on a task and persist the transition. Domain transition +
 * single-task repo update + log. The chain leaf adapts ctx → props → ctx.
 *
 * Resume semantics: if the task carries a leftover `running` attempt from a prior aborted chain
 * (e.g. the user hit Ctrl+C or the host crashed mid-task), the use case settles that attempt as
 * `aborted` first, then opens a fresh attempt. This makes the next Implement launch a transparent
 * resume — no manual cleanup required. The trigger is the running attempt itself, NOT the carried
 * status: a crash can persist a status-corrupt `todo` task whose last attempt is still `running`,
 * and that is healed identically (the leftover attempt is aborted, the status repaired to
 * `in_progress`, a fresh attempt opened) rather than dead-ending at `startNextAttempt`.
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

/**
 * `true` when the in-memory copy of a task no longer matches what is on disk. A stale in-memory
 * cache (e.g. another concurrent operation wrote a new attempt, or the operator manually patched
 * `tasks.json`) would otherwise be silently overwritten by our update, losing whichever change is
 * newer.
 *
 * Compares the cheap discriminators — status, attempt count, last-attempt status, last-attempt
 * `startedAt` — which catch every realistic divergence without serialising the whole object.
 * `startedAt` covers the rare race where another writer replaced the running attempt with one of
 * the same n + status (a different process restarting the attempt): the timestamps differ even
 * when status and length collide.
 */
const detectDivergence = (inMemory: Task, persisted: Task): boolean => {
  const inMemoryLastAttempt = inMemory.attempts.at(-1);
  const persistedLastAttempt = persisted.attempts.at(-1);
  return (
    persisted.status !== inMemory.status ||
    persisted.attempts.length !== inMemory.attempts.length ||
    persistedLastAttempt?.status !== inMemoryLastAttempt?.status ||
    persistedLastAttempt?.startedAt !== inMemoryLastAttempt?.startedAt
  );
};

/** The task to open the fresh attempt on, plus the recovery breadcrumb to stamp onto it. */
interface ResumeOutcome {
  readonly taskToStart: Task;
  readonly recovering: RecoveryContext;
}

/**
 * Settling the leftover attempt pushed the task over `maxAttempts`, so the domain blocked it.
 *
 * Persist the blocked transition BEFORE surfacing the error. Without this the leftover running
 * attempt stays on disk: the next launch re-enters this same resume path, re-settles it to blocked,
 * re-errors — an infinite stuck loop where the task is never reported blocked and never leaves the
 * queue. Persisting makes the block durable, so the launch queue filters it out (blocked is not
 * resumable) and the operator can `unblock` it. A persist failure is surfaced in preference to the
 * blocked-state error (it's the more actionable system fault).
 */
const persistBlockedAfterResume = async (
  props: StartAttemptProps,
  blocked: BlockedTask,
  log: Logger
): Promise<Result<never, InvalidStateError | NotFoundError | StorageError>> => {
  log.warn('task blocked after settling aborted attempt (attempt budget exhausted)', {
    taskId: blocked.id,
    blockedReason: blocked.blockedReason,
  });
  const persisted = await props.taskRepo.update(props.sprintId, blocked);
  if (!persisted.ok) {
    log.error('failed to persist blocked task after resume', {
      taskId: blocked.id,
      error: persisted.error.message,
    });
    return Result.error(persisted.error);
  }
  return Result.error(
    new InvalidStateError({
      entity: 'task',
      currentState: 'blocked',
      attemptedAction: 'start-attempt-after-resume',
      message: `task '${String(blocked.id)}' is blocked: ${blocked.blockedReason ?? 'unknown reason'}`,
    })
  );
};

/**
 * Re-read the task, refuse to proceed on divergence, then settle the leftover `running` attempt as
 * `aborted` so the domain invariant ("only one running attempt at a time") holds before a fresh
 * attempt is appended.
 */
const resumeFromLeftoverAttempt = async (
  props: StartAttemptProps,
  log: Logger
): Promise<Result<ResumeOutcome, InvalidStateError | NotFoundError | StorageError | ValidationError>> => {
  const fresh = await props.taskRepo.findById(props.sprintId, props.task.id);
  if (!fresh.ok) {
    log.warn('resume: could not re-read task for divergence check', {
      taskId: props.task.id,
      error: fresh.error.message,
    });
    return Result.error(fresh.error);
  }
  const persisted = fresh.value;
  if (detectDivergence(props.task, persisted)) {
    log.warn('resume: in-memory task diverges from persisted state — refusing to overwrite', {
      taskId: props.task.id,
      inMemoryStatus: props.task.status,
      persistedStatus: persisted.status,
      inMemoryAttempts: props.task.attempts.length,
      persistedAttempts: persisted.attempts.length,
      inMemoryLastStartedAt: props.task.attempts.at(-1)?.startedAt,
      persistedLastStartedAt: persisted.attempts.at(-1)?.startedAt,
    });
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: persisted.status,
        attemptedAction: 'resume-from-stale-cache',
        message: `task '${String(props.task.id)}' diverges between in-memory (${props.task.status}, ${String(props.task.attempts.length)} attempts) and persisted state (${persisted.status}, ${String(persisted.attempts.length)} attempts). Reload tasks and retry.`,
      })
    );
  }

  // Cause attribution on the cross-process resume path: we don't know what killed the
  // previous process (Ctrl-C, SIGTERM, idle-watchdog, v8 OOM all leave the same trace —
  // a leftover `running` attempt). `process-crash` is the conservative label; the
  // in-process abort path passes a richer cause via `failCurrentAttempt`.
  const priorAttemptN = props.task.attempts.length;
  const abortedAt = props.clock();
  log.info('recovering aborted attempt before resume', {
    taskId: props.task.id,
    priorAttemptN,
    cause: PROCESS_CRASH_CAUSE,
  });
  const aborted = failCurrentAttempt(props.task, abortedAt, 'aborted', { abortCause: PROCESS_CRASH_CAUSE });
  if (!aborted.ok) {
    log.warn('failed to settle prior running attempt during resume', {
      taskId: props.task.id,
      error: aborted.error.message,
    });
    return Result.error(aborted.error);
  }
  if (aborted.value.status === 'blocked') {
    return persistBlockedAfterResume(props, aborted.value, log);
  }
  return Result.ok({
    taskToStart: aborted.value,
    recovering: { fromAttemptN: priorAttemptN, cause: PROCESS_CRASH_CAUSE, abortedAt },
  });
};

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

  // Resume path: a prior chain left a `running` attempt behind. Keyed on the leftover running
  // attempt — NOT on `status === 'in_progress'` — so a status-corrupt `todo` task whose last
  // attempt is still `running` is recovered too (`failCurrentAttempt` repairs the status to
  // `in_progress` as it settles) instead of dead-ending in `startNextAttempt`.
  let taskToStart: Task = props.task;
  let recovering: RecoveryContext | undefined;
  if (hasRunningAttempt(props.task)) {
    const resumed = await resumeFromLeftoverAttempt(props, log);
    if (!resumed.ok) return Result.error(resumed.error);
    taskToStart = resumed.value.taskToStart;
    recovering = resumed.value.recovering;
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
