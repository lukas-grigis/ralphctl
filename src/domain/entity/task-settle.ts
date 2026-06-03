import { Result } from '@src/domain/result.ts';
import {
  type AbortMetadata,
  type Attempt,
  completeAttempt,
  type RunningAttempt,
  type VerifiedAttempt,
} from '@src/domain/entity/attempt.ts';
import type { BlockedTask, DoneTask, InProgressTask, Task, TodoTask } from '@src/domain/entity/task.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { type ValidationError } from '@src/domain/value/error/validation-error.ts';

const requireRunningAttempt = (
  task: TodoTask | InProgressTask
): Result<
  { readonly task: TodoTask | InProgressTask; readonly running: RunningAttempt; readonly idx: number },
  InvalidStateError
> => {
  const idx = task.attempts.length - 1;
  const last = task.attempts[idx];
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
  return Result.ok({ task, running: last, idx });
};

const replaceLastAttempt = (task: TodoTask | InProgressTask, attempt: Attempt): InProgressTask => {
  const next = [...task.attempts];
  next[task.attempts.length - 1] = attempt;
  // Force `in_progress`: a running attempt means the task IS in progress, so settling it always
  // yields an `in_progress` task — even when a crash persisted a status-corrupt `todo` task whose
  // last attempt was still `running`. This is the self-heal half of `failCurrentAttempt` below.
  return { ...task, status: 'in_progress', attempts: next };
};

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
  const inner = requireRunningAttempt(guard.value);
  if (!inner.ok) return Result.error(inner.error);
  const verifiedResult = completeAttempt(inner.value.running, 'verified', now);
  if (!verifiedResult.ok) return Result.error(verifiedResult.error);
  const verified = verifiedResult.value as VerifiedAttempt;

  const head = guard.value.attempts.slice(0, inner.value.idx);
  const attempts = [...head, verified] as readonly [...Attempt[], VerifiedAttempt];

  return Result.ok({
    id: guard.value.id,
    name: guard.value.name,
    ...(guard.value.description !== undefined ? { description: guard.value.description } : {}),
    steps: guard.value.steps,
    verificationCriteria: guard.value.verificationCriteria,
    order: guard.value.order,
    ticketId: guard.value.ticketId,
    dependsOn: guard.value.dependsOn,
    repositoryId: guard.value.repositoryId,
    ...(guard.value.maxAttempts !== undefined ? { maxAttempts: guard.value.maxAttempts } : {}),
    ...(guard.value.extraDimensions !== undefined ? { extraDimensions: guard.value.extraDimensions } : {}),
    ...(guard.value.externalRefs !== undefined ? { externalRefs: guard.value.externalRefs } : {}),
    ...(guard.value.escalatedFromModel !== undefined ? { escalatedFromModel: guard.value.escalatedFromModel } : {}),
    ...(guard.value.escalatedToModel !== undefined ? { escalatedToModel: guard.value.escalatedToModel } : {}),
    status: 'done',
    attempts,
    finalAttemptN: verified.n,
  });
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
  const inner = requireRunningAttempt(guard.value);
  if (!inner.ok) return Result.error(inner.error);
  const settledResult = completeAttempt(inner.value.running, reason, now, abortMeta);
  if (!settledResult.ok) return Result.error(settledResult.error);

  const inProgressNext: InProgressTask = replaceLastAttempt(guard.value, settledResult.value);
  if (guard.value.maxAttempts !== undefined && inProgressNext.attempts.length >= guard.value.maxAttempts) {
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
 * Stamp the once-per-task generator model escalation onto an `in_progress` task. The fields are
 * write-once: a task that already carries either side is rejected so the escalation cap is
 * enforced at the domain layer rather than every caller re-deriving the check.
 */
export const recordTaskEscalation = (
  task: InProgressTask,
  fromModel: string,
  toModel: string
): Result<InProgressTask, InvalidStateError | ValidationError> => {
  if (task.escalatedFromModel !== undefined || task.escalatedToModel !== undefined) {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: 'in_progress',
        attemptedAction: 'record-escalation',
        message: `task '${task.id}' already escalated (${String(task.escalatedFromModel)} → ${String(task.escalatedToModel)})`,
        hint: 'The once-per-task cap blocks a second escalation; transition to blocked instead.',
      })
    );
  }
  const from = parseRequiredString('task.escalatedFromModel', fromModel);
  if (!from.ok) return Result.error(from.error);
  const to = parseRequiredString('task.escalatedToModel', toModel);
  if (!to.ok) return Result.error(to.error);
  return Result.ok({ ...task, escalatedFromModel: from.value, escalatedToModel: to.value });
};
