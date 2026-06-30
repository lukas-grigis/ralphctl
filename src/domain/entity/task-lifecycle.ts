import { Result } from '@src/domain/result.ts';
import type { BlockedTask, Task, TodoTask } from '@src/domain/entity/task.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/**
 * Reason-string prefix the dependency gate stamps on a task blocked solely because a prerequisite
 * was not `done`.
 *
 * @deprecated Superseded by the structural {@link BlockedTask.blockKind} discriminant. Retained
 * ONLY for the read-time migration of legacy `tasks.json` entries lacking `blockKind` (the task
 * schema infers `upstream` from this prefix, `own` otherwise). New code MUST classify via
 * {@link isUpstreamBlocked} / `blockKind`, never the reason text.
 */
export const BLOCKED_UPSTREAM_REASON_PREFIX = 'blocked upstream';

/**
 * True when `task` is blocked specifically because an upstream prerequisite was not done. Reads the
 * structural {@link BlockedTask.blockKind} discriminant — NOT the reason prefix — so an own-failure
 * reason that happens to start with `'blocked upstream'` is correctly NOT treated as upstream.
 */
export const isUpstreamBlocked = (task: Task): task is BlockedTask =>
  task.status === 'blocked' && task.blockKind === 'upstream';

export const markTaskBlocked = (
  task: Task,
  reason: string,
  blockKind: BlockedTask['blockKind']
): Result<BlockedTask, InvalidStateError> => {
  const guard = requireStatus(
    'task',
    task,
    ['todo', 'in_progress'] as const,
    'mark-blocked',
    'Done or already-blocked tasks cannot be re-blocked.'
  );
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok({ ...guard.value, status: 'blocked', blockedReason: reason, blockKind });
};

/**
 * Unblock a `blocked` task back to `todo` as a CLEAN RESTART: strip the block fields AND reset the
 * attempt budget (empty `attempts`) and any carried-over model escalation. A deliberate operator
 * unblock means "the blocker is addressed — give this task a genuine fresh run," so it re-enters
 * with a full `maxAttempts` budget on the configured model, behaving like a freshly-planned task.
 *
 * Without the reset, an own-blocked task sitting at a full attempt history would, on its next run,
 * hit `budget-exhausted` on the first plateau (no room to climb the escalation ladder again) — and
 * carrying a top-of-ladder escalation stamp would `topped-out` immediately. The per-attempt history
 * still lives in `progress.md` and git; only the task's in-memory attempt ledger resets.
 *
 * Distinct from {@link resetTaskToTodo} (crash recovery), which PRESERVES attempts because it
 * resumes mid-work rather than restarting. Upstream-blocked dependents re-armed by the unblock
 * cascade carry no attempts, so the reset is a no-op for them.
 */
export const unblockTask = (task: Task): Result<TodoTask, InvalidStateError> => {
  const guard = requireStatus('task', task, ['blocked'] as const, 'unblock');
  if (!guard.ok) return Result.error(guard.error);
  const {
    blockedReason: _reason,
    blockKind: _kind,
    escalatedFromModel: _from,
    escalatedToModel: _to,
    // A clean restart drops the prior run's per-criterion verdicts too — a freshly-planned task
    // carries no k-of-N history; stale verdicts would mislead the next run's checklist.
    criteriaVerdicts: _verdicts,
    ...rest
  } = guard.value;
  void _reason;
  void _kind;
  void _from;
  void _to;
  void _verdicts;
  return Result.ok({ ...rest, status: 'todo', attempts: [] });
};

/**
 * Reset stale `in_progress` back to `todo` (for crash recovery). Requires there to be no
 * unsettled running attempt — call `failCurrentAttempt(..., 'aborted')` first to settle it.
 */
export const resetTaskToTodo = (task: Task): Result<TodoTask, InvalidStateError> => {
  if (task.status === 'todo') return Result.ok(task);
  const guard = requireStatus(
    'task',
    task,
    ['in_progress'] as const,
    'reset-to-todo',
    'Only `in_progress` tasks can be reset to todo.'
  );
  if (!guard.ok) return Result.error(guard.error);
  const last = guard.value.attempts[guard.value.attempts.length - 1];
  if (last !== undefined && last.status === 'running') {
    return Result.error(
      new InvalidStateError({
        entity: 'task',
        currentState: 'in_progress',
        attemptedAction: 'reset-to-todo',
        message: `task '${guard.value.id}' has a running attempt n=${last.n}`,
        hint: 'Settle the attempt via failCurrentAttempt(..., "aborted") before resetting.',
      })
    );
  }
  return Result.ok({ ...guard.value, status: 'todo' });
};
