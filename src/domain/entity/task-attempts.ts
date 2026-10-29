import { Result } from '@src/domain/result.ts';
import {
  type Attempt,
  isFreeAttempt,
  type AttemptWarning,
  type Attribution,
  type Evaluation,
  type RecoveryContext,
  type RunningAttempt,
  startAttempt,
  type VerifyRun,
} from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task, TodoTask } from '@src/domain/entity/task.ts';
import type { CommitSha } from '@src/domain/value/commit-sha.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { type ValidationError } from '@src/domain/value/error/validation-error.ts';

/** A task interrupted over and over without an attempt finishing must still run out of budget. */
export const MAX_CONSECUTIVE_FREE_ATTEMPTS = 3;

/** The one count every budget check reads: all attempts except free ones within the streak cap. */
export const budgetedAttemptCount = (task: Pick<Task, 'attempts'>): number => {
  let counted = 0;
  let freeStreak = 0;
  for (const att of task.attempts) {
    freeStreak = isFreeAttempt(att) ? freeStreak + 1 : 0;
    if (freeStreak === 0 || freeStreak > MAX_CONSECUTIVE_FREE_ATTEMPTS) counted += 1;
  }
  return counted;
};

/**
 * Newest non-blank `critique` across `holder.attempts`. Walking back past the running attempt lets a
 * resumed attempt's first generator turn start from the aborted attempt's critique instead of cold.
 */
export const latestCritique = (holder: { readonly attempts: readonly Attempt[] }): string | undefined =>
  holder.attempts.findLast((att) => att.critique !== undefined && att.critique.trim().length > 0)?.critique;

export const resumesFreeAttempt = (task: Pick<Task, 'attempts'>): boolean => {
  const previous = task.attempts.at(-2);
  return previous !== undefined && isFreeAttempt(previous);
};

export const requireRunningAttempt = (task: TodoTask | InProgressTask): Result<RunningAttempt, InvalidStateError> => {
  const last = task.attempts.at(-1);
  if (last === undefined || last.status !== 'running') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: task.status,
        attemptedAction: 'record-attempt',
        message: `task '${task.id}' has no running attempt to record into`,
        hint: 'Call startNextAttempt before recording.',
      })
    );
  }
  return Result.ok(last);
};

export const replaceLastAttempt = <T extends TodoTask | InProgressTask>(task: T, attempt: Attempt): T => ({
  ...task,
  attempts: task.attempts.with(-1, attempt),
});

export const updateRunningAttempt = (
  task: InProgressTask,
  fn: (a: RunningAttempt) => RunningAttempt
): Result<InProgressTask, InvalidStateError> => {
  const running = requireRunningAttempt(task);
  if (!running.ok) return Result.error(running.error);
  return Result.ok(replaceLastAttempt(task, fn(running.value)));
};

/**
 * Append a fresh `running` attempt and transition to `in_progress`. A still-running last attempt must
 * be settled first. `recovering` marks the attempt as a resume of an aborted one.
 */
export const startNextAttempt = (
  task: Task,
  now: IsoTimestamp,
  sessionId?: string,
  recovering?: RecoveryContext
): Result<InProgressTask, InvalidStateError | ValidationError> => {
  const guard = requireStatus(
    'task',
    task,
    ['todo', 'in_progress'] as const,
    'start-next-attempt',
    'Only `todo` or `in_progress` tasks can start a new attempt.'
  );
  if (!guard.ok) return Result.error(guard.error);

  const last = guard.value.attempts.at(-1);
  if (last !== undefined && last.status === 'running') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: guard.value.status,
        attemptedAction: 'start-next-attempt',
        message: `task '${guard.value.id}' already has a running attempt n=${last.n}`,
        hint: 'Settle it via markTaskDone or failCurrentAttempt before starting another.',
      })
    );
  }

  const attemptResult = startAttempt({
    n: guard.value.attempts.length + 1,
    startedAt: now,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(recovering !== undefined ? { recovering } : {}),
  });
  if (!attemptResult.ok) return Result.error(attemptResult.error);

  return Result.ok({
    ...guard.value,
    status: 'in_progress',
    attempts: [...guard.value.attempts, attemptResult.value],
  });
};

export const recordRunningAttemptVerification = (task: InProgressTask): Result<InProgressTask, InvalidStateError> =>
  updateRunningAttempt(task, (a) => ({ ...a, verification: {} }));

export const recordRunningAttemptEvaluation = (
  task: InProgressTask,
  evaluation: Evaluation
): Result<InProgressTask, InvalidStateError> => updateRunningAttempt(task, (a) => ({ ...a, evaluation }));

export const recordRunningAttemptCritique = (
  task: InProgressTask,
  text: string
): Result<InProgressTask, InvalidStateError | ValidationError> => {
  const running = requireRunningAttempt(task);
  if (!running.ok) return Result.error(running.error);
  const parsed = parseRequiredString('attempt.critique', text);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok(replaceLastAttempt(task, { ...running.value, critique: parsed.value }));
};

export const recordRunningAttemptCommit = (
  task: InProgressTask,
  sha: CommitSha
): Result<InProgressTask, InvalidStateError> => updateRunningAttempt(task, (a) => ({ ...a, commitSha: sha }));

/** Overwrites any earlier warning: a red verify after a budget warning is the failure the operator should see. */
export const recordRunningAttemptWarning = (
  task: InProgressTask,
  warning: AttemptWarning
): Result<InProgressTask, InvalidStateError> => updateRunningAttempt(task, (a) => ({ ...a, warning }));

/**
 * Drop a softened-plateau warning when the grace round then passed cleanly, so a genuine pass isn't
 * branded pass-with-warning. Only kind `plateau` — a `verify-failed` warning records a real fact.
 */
export const clearRunningAttemptPlateauWarning = (task: InProgressTask): InProgressTask => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return task;
  const { warning, ...rest } = guard.value;
  return warning?.kind === 'plateau' ? replaceLastAttempt(task, rest) : task;
};

export const appendAttemptVerifyRun = (
  task: InProgressTask,
  run: VerifyRun
): Result<InProgressTask, InvalidStateError> =>
  updateRunningAttempt(task, (a) => ({ ...a, verifyRuns: [...(a.verifyRuns ?? []), run] }));

export const setAttemptAttribution = (
  task: InProgressTask,
  attribution: Attribution
): Result<InProgressTask, InvalidStateError> => updateRunningAttempt(task, (a) => ({ ...a, attribution }));

export const markAttemptBaselineBroken = (task: InProgressTask): Result<InProgressTask, InvalidStateError> =>
  updateRunningAttempt(task, (a) => ({ ...a, baselineBroken: true }));
