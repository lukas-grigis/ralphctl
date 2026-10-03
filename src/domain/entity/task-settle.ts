import { Result } from '@src/domain/result.ts';
import {
  type AbortMetadata,
  type Attempt,
  completeAttempt,
  type VerifiedAttempt,
  verifyAttempt,
} from '@src/domain/entity/attempt.ts';
import type { BlockedTask, DoneTask, InProgressTask, Task } from '@src/domain/entity/task.ts';
import { budgetedAttemptCount, replaceLastAttempt, requireRunningAttempt } from '@src/domain/entity/task-attempts.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Settle the current attempt as `verified` and transition the task to `done`. Requires the
 * running attempt to carry a `Verification` (call `recordRunningAttemptVerification` first).
 * `finalAttemptN` points at the verified attempt for cheap lookup.
 */
export const markTaskDone = (task: Task, now: IsoTimestamp): Result<DoneTask, InvalidStateError> => {
  const guard = requireStatus(
    'task',
    task,
    ['in_progress'] as const,
    'mark-done',
    'Only `in_progress` tasks can be marked done.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const running = requireRunningAttempt(guard.value);
  if (!running.ok) return Result.error(running.error);
  const verified = verifyAttempt(running.value, now);
  if (!verified.ok) return Result.error(verified.error);

  const attempts: readonly [...Attempt[], VerifiedAttempt] = [...guard.value.attempts.slice(0, -1), verified.value];
  // Spread, not enumerate: harness-owned history (criteriaVerdicts, escalation stamps, retiredAttempts) must survive into done.
  return Result.ok({ ...guard.value, status: 'done', attempts, finalAttemptN: verified.value.n });
};

/**
 * Settle the current attempt as `failed`/`malformed`/`aborted`. If `maxAttempts` is set and
 * reached, transitions the task to `blocked` with reason `'attempt budget exhausted'`. Otherwise
 * the task settles to `in_progress` and the caller can `startNextAttempt` again.
 *
 * The real precondition is "a running attempt exists" (enforced by `requireRunningAttempt`), not
 * the task's nominal status — so this also heals a status-corrupt `todo` task whose last attempt is
 * still `running` (the crash signature a prior process can persist). Such a task settles to a clean
 * `in_progress`; a normal `todo` task with no running attempt is still rejected. The `start-attempt`
 * use case relies on this to resume a crashed run regardless of the carried status.
 *
 * The optional `abortMeta` is forwarded to {@link completeAttempt} — meaningful only when
 * `reason === 'aborted'`. The `start-attempt` use case supplies it on the resume path so the
 * leftover running attempt carries `abortCause` + (optional) `signalOrExitCode` into history.
 */
export const failCurrentAttempt = (
  task: Task,
  now: IsoTimestamp,
  reason: 'failed' | 'malformed' | 'aborted',
  abortMeta?: AbortMetadata
): Result<InProgressTask | BlockedTask, InvalidStateError> => {
  const guard = requireStatus(
    'task',
    task,
    ['todo', 'in_progress'] as const,
    'fail-current-attempt',
    'Only a task carrying a running attempt can have its current attempt failed.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const running = requireRunningAttempt(guard.value);
  if (!running.ok) return Result.error(running.error);
  const settled = completeAttempt(running.value, reason, now, abortMeta);

  // Force `in_progress`: a running attempt means the task IS in progress, so settling it always
  // yields an `in_progress` task — even when a crash persisted a status-corrupt `todo` task whose
  // last attempt was still `running`. This is the self-heal described above.
  const inProgressNext: InProgressTask = { ...replaceLastAttempt(guard.value, settled), status: 'in_progress' };
  if (guard.value.maxAttempts !== undefined && budgetedAttemptCount(inProgressNext) >= guard.value.maxAttempts) {
    const blocked: BlockedTask = {
      ...inProgressNext,
      status: 'blocked',
      blockedReason: `attempt budget exhausted (maxAttempts=${guard.value.maxAttempts})`,
      // Budget exhaustion is an own-failure block — the operator must address the failures; it never
      // cascade-clears via the upstream-unblock path.
      blockKind: 'own',
    };
    return Result.ok(blocked);
  }
  return Result.ok(inProgressNext);
};

/**
 * Stamp the generator model escalation onto an `in_progress` task. The fields hold the
 * MOST-RECENT rung transition and are re-stampable: a task may be re-stamped on each plateau as
 * it climbs the ladder one rung at a time, and a top-of-ladder same-model nudge stamps
 * `from === to`. The cost ceiling is enforced by the policy (ladder top + `maxAttempts`), not
 * here — this helper only validates the two model strings and records the latest transition.
 */
export const recordTaskEscalation = (
  task: InProgressTask,
  fromModel: string,
  toModel: string
): Result<InProgressTask, ValidationError> => {
  const from = parseRequiredString('task.escalatedFromModel', fromModel);
  if (!from.ok) return Result.error(from.error);
  const to = parseRequiredString('task.escalatedToModel', toModel);
  if (!to.ok) return Result.error(to.error);
  return Result.ok({ ...task, escalatedFromModel: from.value, escalatedToModel: to.value });
};

/**
 * Stamp the same-model effort escalation onto an `in_progress` task. The counterpart of
 * {@link recordTaskEscalation} for the graduated ladder's EFFORT rung: the model is unchanged, so
 * only {@link InProgressTask.escalatedToEffort} is recorded — the generator leaf reads it on the
 * next attempt to spawn at the raised reasoning effort. Re-stampable, but the policy fires the rung
 * at most once (the next plateau sees the raised effort and falls through to the nudge). Validates
 * the effort string is non-empty; the cost ceiling is policy-enforced, not here.
 */
export const recordTaskEffortEscalation = (
  task: InProgressTask,
  toEffort: string
): Result<InProgressTask, ValidationError> => {
  const to = parseRequiredString('task.escalatedToEffort', toEffort);
  if (!to.ok) return Result.error(to.error);
  return Result.ok({ ...task, escalatedToEffort: to.value });
};

/**
 * Stamp the same-model EVALUATOR effort escalation onto an `in_progress` task — the evaluator-side
 * counterpart of {@link recordTaskEffortEscalation}. The evaluator's model never changes, so only
 * {@link InProgressTask.escalatedToEvaluatorEffort} is recorded; the evaluator leaf reads it on the
 * next attempt to spawn at the raised reasoning effort. Validates the effort string is non-empty;
 * the cost ceiling is policy-enforced (the evaluator's own effort ladder), not here.
 */
export const recordTaskEvaluatorEffortEscalation = (
  task: InProgressTask,
  toEffort: string
): Result<InProgressTask, ValidationError> => {
  const to = parseRequiredString('task.escalatedToEvaluatorEffort', toEffort);
  if (!to.ok) return Result.error(to.error);
  return Result.ok({ ...task, escalatedToEvaluatorEffort: to.value });
};

/** Floor for a granted best-of-N candidate count — mirrors `settings.harness.bestOfNCandidates`'s
 * schema floor (`domain/entity/settings.ts`); `0` (disabled) never reaches this helper. */
const MIN_BEST_OF_N_CANDIDATES = 2;

/**
 * Stamp the once-per-task best-of-N grant onto an `in_progress` task — the counterpart of
 * {@link recordTaskEscalation} / {@link recordTaskEffortEscalation} for the escalation ladder's
 * opt-in top-of-ladder remedy. Sets the PERMANENT {@link InProgressTask.bestOfNGranted} marker
 * (never cleared — `decideEscalation` reads it for the once-per-task gate) alongside the
 * transient {@link InProgressTask.bestOfNGrantedCandidates} handshake value the attempt-body
 * consumes at start-attempt. Unlike the model/effort stamps, this is NOT re-stampable in
 * practice — the policy only ever returns `best-of-n` once per task (the permanent marker this
 * helper sets is exactly what stops a second grant) — but the helper itself does not enforce
 * that; `decideEscalation` is the single source of truth for the once-per-task rule.
 */
export const recordTaskBestOfNGrant = (task: InProgressTask, n: number): Result<InProgressTask, ValidationError> => {
  if (!Number.isInteger(n) || n < MIN_BEST_OF_N_CANDIDATES) {
    return Result.error(
      new ValidationError({
        field: 'task.bestOfNGrantedCandidates',
        value: n,
        message: `task.bestOfNGrantedCandidates must be an integer >= ${String(MIN_BEST_OF_N_CANDIDATES)}`,
      })
    );
  }
  return Result.ok({ ...task, bestOfNGranted: true, bestOfNGrantedCandidates: n });
};
