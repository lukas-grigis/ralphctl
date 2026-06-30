import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import { resetTaskToTodo, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import { upstreamBlockedDependents } from '@src/domain/entity/task-graph.ts';
import { type Sprint, revertSprintToActive } from '@src/domain/entity/sprint.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** Log message shared by the persist-failure branches (primary update + cascade saveAll). */
const PERSIST_FAILED_MSG = 'persist failed';

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
 * **Sprint reopen.** A mixed run (some tasks `done`, some `blocked`) settles the sprint to
 * `review`. Reviving a `todo` task there means the sprint is no longer review-complete and the
 * implement gate (`planned` / `active` only) would otherwise leave the revived work stranded. So
 * after a successful unblock this reopens a `review` sprint to `active` (see
 * {@link revertSprintToActive}). Best-effort and idempotent: a non-`review` sprint passes through
 * untouched, and a reopen that fails to persist is logged but does not fail the unblock — the task
 * is already revived, and re-running unblock retries the reopen (the already-`todo` short-circuit
 * still reopens).
 *
 * **TOCTOU precondition.** The cascade path does an UNLOCKED `findBySprintId` read whose result
 * seeds the (now-locked) `saveAll` rewrite — the read that feeds the rewrite happens before any
 * lock is taken. So this use case MUST NOT run while an Implement run is active on the same sprint:
 * a concurrent run could mutate `tasks.json` between the read and the write, and the rewrite would
 * clobber those changes with stale data. Callers serialise via the sprint-dir repo lock; this is an
 * operator-facing recovery hatch invoked between runs, not during one.
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
  /** Used to reopen a `review` sprint to `active` once there is `todo` work again. */
  readonly sprintRepo: FindById<Sprint, SprintId> & Save<Sprint>;
  /** Wall-clock for the reopen's `activatedAt` re-stamp. */
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export type UnblockTaskOutput = TodoTask;

export const unblockTaskUseCase = async (
  props: UnblockTaskProps
): Promise<Result<UnblockTaskOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const log = props.logger.named('task.unblock');

  // Reopen a `review` sprint to `active` so the implement gate re-arms now there's `todo` work.
  // Best-effort: the unblock has already persisted by the time this runs, so a failed reopen is
  // logged and swallowed rather than failing the operation — re-running unblock retries it.
  const reopenSprintIfReview = async (): Promise<void> => {
    const loaded = await props.sprintRepo.findById(props.sprintId);
    if (!loaded.ok) {
      log.warn('could not load sprint to reopen after unblock', {
        sprintId: props.sprintId,
        error: loaded.error.message,
      });
      return;
    }
    if (loaded.value.status !== 'review') return;
    const reopened = revertSprintToActive(loaded.value, props.clock());
    if (!reopened.ok) {
      log.warn('could not reopen sprint after unblock', {
        sprintId: props.sprintId,
        error: reopened.error.message,
      });
      return;
    }
    const saved = await props.sprintRepo.save(reopened.value);
    if (!saved.ok) {
      log.warn('could not persist reopened sprint after unblock', {
        sprintId: props.sprintId,
        error: saved.error.message,
      });
      return;
    }
    log.info(`sprint '${reopened.value.slug}' reopened review → active to resume unblocked work`, {
      sprintId: props.sprintId,
    });
  };

  if (props.task.status === 'todo') {
    log.debug('already todo, skipping task transition', { taskId: props.task.id, sprintId: props.sprintId });
    await reopenSprintIfReview();
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
      log.error(PERSIST_FAILED_MSG, { taskId: primary.id, error: persisted.error.message });
      return Result.error(persisted.error);
    }
    log.info(`unblocked task '${primary.name}'`, { taskId: primary.id, sprintId: props.sprintId });
    await reopenSprintIfReview();
    return Result.ok(primary);
  }

  const dependentIds = new Set(upstreamBlockedDependents(all.value, primary.id));

  // Common case — no upstream-blocked dependents to re-arm. Persist just the primary via the
  // single-task `update` (no need to rewrite the whole list).
  if (dependentIds.size === 0) {
    const persisted = await props.taskRepo.update(props.sprintId, primary);
    if (!persisted.ok) {
      log.error(PERSIST_FAILED_MSG, { taskId: primary.id, error: persisted.error.message });
      return Result.error(persisted.error);
    }
    log.info(`unblocked task '${primary.name}'`, { taskId: primary.id, sprintId: props.sprintId });
    await reopenSprintIfReview();
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
    log.error(PERSIST_FAILED_MSG, { taskId: primary.id, error: saved.error.message });
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
  await reopenSprintIfReview();
  return Result.ok(primary);
};
