import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import { resetTaskToTodo, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import { upstreamBlockedDependents } from '@src/domain/entity/task-graph.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Manually unblock a task — recovery hatch for transient failures that leave a task stuck in
 * `blocked` (maxAttempts exhausted, verify failed) or `in_progress` with a settled last attempt
 * (crash recovery, watchdog kill). Both map to the same operator-visible "stuck" concept: the
 * task needs to be reset to `todo` so the next implement run can retry it.
 *
 * **Cascade.** Unblocking a task ALSO re-arms its upstream-blocked dependents — the tasks the
 * dependency gate parked because this one was not `done` (see {@link upstreamBlockedDependents}).
 * So the operator fixes the root prerequisite, unblocks it once, and relaunches; the whole subtree
 * the gate blocked is reset to `todo` in the same transaction rather than needing a manual unblock
 * each. Own-failure blocks (eval/verify/budget) in the subtree are left untouched — they need a
 * real fix. Re-arming is safe even when a dependent has a second still-blocked prerequisite: the
 * dependency gate re-blocks it on the next run.
 *
 * Policy: domain transition + persist + log. Idempotent — an already-`todo` task passes through
 * unchanged (mirrors {@link activateSprintUseCase}'s shape).
 *
 * `blocked` → {@link unblockTask} (strips `blockedReason`, resets to `todo`).
 * `in_progress` with a settled last attempt → {@link resetTaskToTodo} (crash-recovery path).
 * `in_progress` with a still-running attempt → rejects with `InvalidStateError` (unsafe to reset).
 * `done` → rejects with `InvalidStateError`.
 */
export interface UnblockTaskProps {
  readonly task: Task;
  readonly sprintId: SprintId;
  /** Composite is supplied by callers; the use case needs read + atomic-rewrite for the cascade. */
  readonly taskRepo: UpdateTask & FindTasksBySprintId & SaveAllTasks;
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

  log.debug('unblocking task', { taskId: props.task.id, sprintId: props.sprintId, from: props.task.status });

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
  const primary = transitioned.value;

  // Load the sprint's tasks so we can cascade-unblock the dependency-gate subtree this task rooted.
  const all = await props.taskRepo.findBySprintId(props.sprintId);
  if (!all.ok) {
    // Cascade is best-effort: if siblings can't be read, still persist the primary so the unblock
    // isn't lost — the operator can re-run unblock to pick up any stranded dependents.
    log.warn('could not load sibling tasks for cascade — unblocking primary only', {
      taskId: primary.id,
      error: all.error.message,
    });
    const persisted = await props.taskRepo.update(props.sprintId, primary);
    if (!persisted.ok) {
      log.error('persist failed', { taskId: primary.id, error: persisted.error.message });
      return Result.error(persisted.error);
    }
    log.info(`unblocked task '${primary.name}'`, { taskId: primary.id, sprintId: props.sprintId });
    return Result.ok(primary);
  }

  const dependentIds = new Set(upstreamBlockedDependents(all.value, primary.id));

  // Common case — no upstream-blocked dependents to re-arm. Persist just the primary via the
  // single-task `update` (no need to rewrite the whole list).
  if (dependentIds.size === 0) {
    const persisted = await props.taskRepo.update(props.sprintId, primary);
    if (!persisted.ok) {
      log.error('persist failed', { taskId: primary.id, error: persisted.error.message });
      return Result.error(persisted.error);
    }
    log.info(`unblocked task '${primary.name}'`, { taskId: primary.id, sprintId: props.sprintId });
    return Result.ok(primary);
  }

  // Cascade — rewrite the whole task list atomically so the primary AND its re-armed dependents
  // land in one transaction.
  const cascaded: TodoTask[] = [];
  const nextTasks = all.value.map((t) => {
    if (t.id === primary.id) return primary;
    if (!dependentIds.has(t.id)) return t;
    const reset = unblockTask(t);
    if (!reset.ok) return t; // defensive: closure already filtered to blocked tasks
    cascaded.push(reset.value);
    return reset.value;
  });

  const saved = await props.taskRepo.saveAll(props.sprintId, nextTasks);
  if (!saved.ok) {
    log.error('persist failed', { taskId: primary.id, error: saved.error.message });
    return Result.error(saved.error);
  }

  log.info(
    `unblocked task '${primary.name}' (+${String(cascaded.length)} upstream dependent${cascaded.length === 1 ? '' : 's'} re-armed)`,
    {
      taskId: primary.id,
      sprintId: props.sprintId,
      cascaded: cascaded.map((t) => String(t.id)),
    }
  );
  return Result.ok(primary);
};
