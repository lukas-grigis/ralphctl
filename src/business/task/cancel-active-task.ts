import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { classifyBlock, markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Mark a task `blocked` with the supplied reason and persist the transition.
 *
 * Driven by the TUI's "cancel whole flow" interaction (the `c` scope picker → option 2): the
 * operator wants the harness to drop the currently-executing task into the blocked column and
 * unwind the chain. The execute-view caller pairs this with `sessions.abort(...)` so the chain
 * unwinds AFTER the task has been pinned to its new state.
 *
 * Domain transition (`markTaskBlocked`) only accepts `todo` / `in_progress` — the use case
 * surfaces the resulting `InvalidStateError` verbatim when the task is already `done` or
 * `blocked`. Already-blocked tasks pass through as a no-op so re-pressing the hotkey is safe.
 *
 * @public
 */
export interface CancelActiveTaskProps {
  readonly task: Task;
  readonly sprintId: SprintId;
  readonly reason: string;
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
  readonly clock: () => IsoTimestamp;
}

/** @public */
export type CancelActiveTaskOutput = BlockedTask;

const blockCancelledTask = (props: CancelActiveTaskProps): Result<BlockedTask, InvalidStateError> => {
  // Operator-initiated cancel is an own-failure block — it never cascade-clears via upstream unblock.
  if (props.task.attempts.at(-1)?.status !== 'running') return markTaskBlocked(props.task, props.reason, 'own');
  // Settle the running attempt first — a blocked task's attempt can't be settled later.
  const aborted = failCurrentAttempt(props.task, props.clock(), 'aborted', { abortCause: 'user-cancel' });
  if (!aborted.ok) return Result.error(aborted.error);
  if (aborted.value.status === 'blocked') {
    return Result.ok({
      ...aborted.value,
      blockedReason: props.reason,
      blockKind: 'own',
      ...classifyBlock(props.reason, 'own'),
    });
  }
  return markTaskBlocked(aborted.value, props.reason, 'own');
};

export const cancelActiveTaskUseCase = async (
  props: CancelActiveTaskProps
): Promise<Result<CancelActiveTaskOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const log = props.logger.named('task.cancel-active');

  if (props.task.status === 'blocked') {
    log.debug('already blocked, skipping', {
      taskId: props.task.id,
      sprintId: props.sprintId,
      blockedReason: props.task.blockedReason,
    });
    return Result.ok(props.task);
  }

  const transitioned = blockCancelledTask(props);
  if (!transitioned.ok) {
    log.warn('invalid state transition', {
      taskId: props.task.id,
      from: props.task.status,
      error: transitioned.error.message,
    });
    return Result.error(transitioned.error);
  }

  const persisted = await props.taskRepo.update(props.sprintId, transitioned.value);
  if (!persisted.ok) {
    log.error('persist failed', { taskId: transitioned.value.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }

  log.info(`cancelled task '${transitioned.value.name}'`, {
    taskId: transitioned.value.id,
    sprintId: props.sprintId,
    reason: props.reason,
  });
  return Result.ok(transitioned.value);
};
