import { Result } from '@src/domain/result.ts';
import {
  appendVerifyRun,
  type Attempt,
  type AttemptWarning,
  type Attribution,
  type Evaluation,
  markBaselineBroken,
  recordAttemptCommit,
  recordAttemptCritique,
  recordAttemptEvaluation,
  recordAttemptVerification,
  recordAttemptWarning,
  type RecoveryContext,
  type RunningAttempt,
  setAttribution,
  startAttempt,
  type VerifyRun,
} from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { CommitSha } from '@src/domain/value/commit-sha.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { type ValidationError } from '@src/domain/value/error/validation-error.ts';

const lastAttempt = (task: Task): Attempt | undefined => task.attempts[task.attempts.length - 1];

const requireRunningAttempt = (
  task: InProgressTask
): Result<
  { readonly task: InProgressTask; readonly running: RunningAttempt; readonly idx: number },
  InvalidStateError
> => {
  const idx = task.attempts.length - 1;
  const last = task.attempts[idx];
  if (last === undefined || last.status !== 'running') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: 'in_progress',
        attemptedAction: 'record-attempt',
        message: `task '${task.id}' has no running attempt to record into`,
        hint: 'Call startNextAttempt before recording.',
      })
    );
  }
  return Result.ok({ task, running: last, idx });
};

const replaceLastAttempt = (task: InProgressTask, attempt: Attempt): InProgressTask => {
  const next = [...task.attempts];
  next[task.attempts.length - 1] = attempt;
  return { ...task, attempts: next };
};

/**
 * Append a fresh `running` attempt and transition to `in_progress`. Idempotent only on a
 * fresh task — if the current last attempt is already `running`, callers must settle it first
 * via `markTaskDone` or `failCurrentAttempt`. A `done`/`blocked` task is rejected.
 *
 * Pass `recovering` when this attempt is opening as a resume of a prior aborted attempt;
 * the value is stamped onto the new `RunningAttempt` so the TUI can render the
 * resume-from-aborted banner without walking the attempt history.
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

  const last = lastAttempt(guard.value);
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

  const attemptInput: {
    n: number;
    startedAt: IsoTimestamp;
    sessionId?: string;
    recovering?: RecoveryContext;
  } = {
    n: guard.value.attempts.length + 1,
    startedAt: now,
  };
  if (sessionId !== undefined) attemptInput.sessionId = sessionId;
  if (recovering !== undefined) attemptInput.recovering = recovering;
  const attemptResult = startAttempt(attemptInput);
  if (!attemptResult.ok) return Result.error(attemptResult.error);

  return Result.ok({
    ...guard.value,
    status: 'in_progress',
    attempts: [...guard.value.attempts, attemptResult.value],
  });
};

export const recordRunningAttemptVerification = (task: InProgressTask): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptVerification(guard.value.running)));
};

export const recordRunningAttemptEvaluation = (
  task: InProgressTask,
  evaluation: Evaluation
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptEvaluation(guard.value.running, evaluation)));
};

export const recordRunningAttemptCritique = (
  task: InProgressTask,
  text: string
): Result<InProgressTask, InvalidStateError | ValidationError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  const parsed = parseRequiredString('attempt.critique', text);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptCritique(guard.value.running, parsed.value)));
};

export const recordRunningAttemptCommit = (
  task: InProgressTask,
  sha: CommitSha
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptCommit(guard.value.running, sha)));
};

/**
 * Stamp a structured `AttemptWarning` onto the running attempt. Used by:
 *   - `gen-eval-loop` when the inner loop terminates with budget-exhausted / plateau / malformed
 *   - `post-task-verify` when the verify script runs red after commit
 *
 * The warning travels with the attempt into `markTaskDone`. At most one warning per attempt;
 * if the inner loop emits a budget warning and verify then runs red, the verify warning
 * overwrites — the more recent failure is the one the operator should see first.
 */
export const recordRunningAttemptWarning = (
  task: InProgressTask,
  warning: AttemptWarning
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, recordAttemptWarning(guard.value.running, warning)));
};

/**
 * Append a {@link VerifyRun} row to the running attempt's audit array. Used by the harness
 * pre/post verify-script leaves to persist deterministic verification results independent of
 * the AI's `task-verified` self-report.
 */
export const appendAttemptVerifyRun = (
  task: InProgressTask,
  run: VerifyRun
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, appendVerifyRun(guard.value.running, run)));
};

/**
 * Stamp the {@link Attribution} verdict on the running attempt. Set by post-task-verify after
 * comparing the pre and post verify-script outcomes.
 */
export const setAttemptAttribution = (
  task: InProgressTask,
  attribution: Attribution
): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, setAttribution(guard.value.running, attribution)));
};

/**
 * Set the running attempt's `baselineBroken` flag — pre-task-verify ran red before the AI got
 * a chance to run, so a downstream red verdict may not be the AI's fault.
 */
export const markAttemptBaselineBroken = (task: InProgressTask): Result<InProgressTask, InvalidStateError> => {
  const guard = requireRunningAttempt(task);
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok(replaceLastAttempt(task, markBaselineBroken(guard.value.running)));
};
