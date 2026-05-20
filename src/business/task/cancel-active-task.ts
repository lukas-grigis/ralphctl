import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { markTaskBlocked, type BlockedTask, type Task } from '@src/domain/entity/task.ts';
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
}

/** @public */
export type CancelActiveTaskOutput = BlockedTask;

/** @public */
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

  const transitioned = markTaskBlocked(props.task, props.reason);
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
