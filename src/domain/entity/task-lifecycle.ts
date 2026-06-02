import { Result } from '@src/domain/result.ts';
import type { BlockedTask, Task, TodoTask } from '@src/domain/entity/task.ts';
import { requireStatus } from '@src/domain/value/require-status.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

/**
 * Reason-string prefix the dependency gate stamps on a task blocked solely because a prerequisite
 * was not `done`. It distinguishes an UPSTREAM-cascade block (mechanically clearable — it auto-
 * resolves once the root prerequisite is unblocked / completed) from an OWN-failure block
 * (eval/verify/budget — needs the operator to actually fix something). {@link isUpstreamBlocked}
 * reads it so `unblockTaskUseCase` can cascade-unblock these dependents when their root unblocks.
 */
export const BLOCKED_UPSTREAM_REASON_PREFIX = 'blocked upstream';

/** True when `task` is blocked specifically because an upstream prerequisite was not done. */
export const isUpstreamBlocked = (task: Task): task is BlockedTask =>
  task.status === 'blocked' && task.blockedReason.startsWith(BLOCKED_UPSTREAM_REASON_PREFIX);

export const markTaskBlocked = (task: Task, reason: string): Result<BlockedTask, InvalidStateError> => {
  const guard = requireStatus(
    'task',
    task,
    ['todo', 'in_progress'] as const,
    'mark-blocked',
    'Done or already-blocked tasks cannot be re-blocked.'
  );
  if (!guard.ok) return Result.error(guard.error);
  return Result.ok({ ...guard.value, status: 'blocked', blockedReason: reason });
};

export const unblockTask = (task: Task): Result<TodoTask, InvalidStateError> => {
  const guard = requireStatus('task', task, ['blocked'] as const, 'unblock');
  if (!guard.ok) return Result.error(guard.error);
  const { blockedReason: _ignored, ...rest } = guard.value;
  void _ignored;
  return Result.ok({ ...rest, status: 'todo' });
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
