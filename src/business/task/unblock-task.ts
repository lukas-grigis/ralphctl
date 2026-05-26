import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import { unblockTask, resetTaskToTodo } from '@src/domain/entity/task-lifecycle.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Manually unblock a task — recovery hatch for transient failures that leave a task stuck in
 * `blocked` (maxAttempts exhausted, verify failed) or `in_progress` with a settled last attempt
 * (crash recovery, watchdog kill). Both map to the same operator-visible "stuck" concept: the
 * task needs to be reset to `todo` so the next implement run can retry it.
 *
 * Policy: domain transition + persist + log. Idempotent — an already-`todo` task passes
 * through unchanged (mirrors {@link activateSprintUseCase}'s shape).
 *
 * `blocked` → {@link unblockTask} (strips `blockedReason`, resets to `todo`).
 * `in_progress` with a settled last attempt → {@link resetTaskToTodo} (crash-recovery path).
 * `in_progress` with a still-running attempt → rejects with `InvalidStateError` (unsafe to reset).
 * `done` → rejects with `InvalidStateError`.
 */
export interface UnblockTaskProps {
  readonly task: Task;
  readonly sprintId: SprintId;
  readonly taskRepo: UpdateTask;
  readonly logger: Logger;
}

export type UnblockTaskOutput = TodoTask;

export const unblockTaskUseCase = async (
  props: UnblockTaskProps
): Promise<Result<UnblockTaskOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const log = props.logger.named('task.unblock');

  if (props.task.status === 'todo') {
    log.debug('already todo, skipping', { taskId: props.task.id, sprintId: props.sprintId });
    return Result.ok(props.task);
  }

  log.debug('unblocking task', {
    taskId: props.task.id,
    sprintId: props.sprintId,
    from: props.task.status,
  });

  // `in_progress` with a settled last attempt = crash-recovery path (Ctrl-C / watchdog kill).
  // Route through resetTaskToTodo, which guards against still-running attempts.
  const transitioned = props.task.status === 'in_progress' ? resetTaskToTodo(props.task) : unblockTask(props.task);
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

  log.info(`unblocked task '${transitioned.value.name}'`, {
    taskId: transitioned.value.id,
    sprintId: props.sprintId,
  });
  return Result.ok(transitioned.value);
};
