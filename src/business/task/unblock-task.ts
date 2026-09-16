import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import { resetTaskToTodo, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import { upstreamBlockedDependents } from '@src/domain/entity/task-graph.ts';
import { reopenDoneSprint, type Sprint, revertSprintToActive } from '@src/domain/entity/sprint.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { assertNoActivePeer } from '@src/business/_shared/assert-no-active-peer.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ConflictError } from '@src/domain/value/error/conflict-error.ts';
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
 * {@link revertSprintToActive}). A `done` sprint — the operator closed it with this task still
 * blocked — gets the same treatment one hop earlier: {@link reopenDoneSprint} first carries it to
 * `review`, then the same review → active step runs on the result, so a closed sprint's blocked
 * work is never permanently unreachable. Both hops are best-effort and idempotent: a
 * sprint that is already open (`draft` / `planned` / `active`) passes through untouched, and a
 * reopen that fails to persist at either hop is logged but does not fail the unblock — the task is
 * already revived, and re-running unblock retries the reopen (the already-`todo` short-circuit
 * still reopens).
 *
 * **Single-active-per-project invariant.** `done` is NOT one of the two states that hold the
 * project (the check scans `active` / `review`), so a project may legally hold one `active` sprint
 * next to a closed one. The `done` → `review` hop above would pull the closed sprint back in
 * alongside that live peer, and the two would not mutually exclude on the shared working tree —
 * the cross-process repo lock is keyed per sprint dir, not per project. So the hop runs the SAME
 * check `reopenDoneSprintUseCase` runs before the identical transition — literally the same
 * function, {@link assertNoActivePeer}, which lives under `business/_shared/` rather than
 * `business/sprint/` so this module can reach it past the sibling-business ESLint fence
 * (`ralphctl sprint reopen` refuses the transition; `task unblock` must not perform it silently).
 * On conflict the reopen is skipped, not the unblock: the task is still revived, and the
 * `ConflictError` rides out on {@link UnblockTaskOutput.sprintReopenConflict} so the CLI / TUI can
 * tell the operator the sprint stayed closed and which peer holds the project.
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
  /**
   * Used to reopen a `review` sprint to `active` once there is `todo` work again. `list` is the
   * peer check's read — reopening a `done` sprint is subject to the single-active-per-project
   * invariant, which can only be answered by scanning the project's other sprints.
   */
  readonly sprintRepo: FindById<Sprint, SprintId> & Save<Sprint> & ListAll<Sprint>;
  /** Wall-clock for the reopen's `activatedAt` re-stamp. */
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

export interface UnblockTaskOutput {
  /** The revived task. Always present — every reopen outcome below is best-effort. */
  readonly task: TodoTask;
  /**
   * Set when the sprint stayed closed because another sprint of the same project is already
   * `active` / `review`. The unblock itself succeeded; this is the operator-facing "and the sprint
   * did NOT reopen, because …" half, which would otherwise be visible only in a log line the CLI
   * never renders (`bootstrapCli` attaches no log subscriber).
   */
  readonly sprintReopenConflict?: ConflictError;
}

/** Assemble the output envelope — the conflict key is omitted entirely when there was none. */
const outputWith = (task: TodoTask, sprintReopenConflict: ConflictError | undefined): UnblockTaskOutput => ({
  task,
  ...(sprintReopenConflict !== undefined ? { sprintReopenConflict } : {}),
});

/** Persist one reopen hop. Best-effort: a failure is logged and swallowed — see below. */
const persistReopen = async (
  props: UnblockTaskProps,
  next: Sprint,
  hop: string,
  log: Logger
): Promise<Sprint | undefined> => {
  const saved = await props.sprintRepo.save(next);
  if (!saved.ok) {
    log.warn('could not persist reopened sprint after unblock', {
      sprintId: props.sprintId,
      hop,
      error: saved.error.message,
    });
    return undefined;
  }
  log.info(`sprint '${next.slug}' reopened ${hop} to resume unblocked work`, { sprintId: props.sprintId });
  return next;
};

/**
 * Reopen a `done` or `review` sprint to `active` so the implement gate re-arms now there's `todo`
 * work. A `done` sprint hops through `review` first via the domain's {@link reopenDoneSprint} — so
 * the review → active step below carries it the rest of the way, rather than a sprint gaining a
 * second, parallel done → active transition to keep in sync with it. Best-effort at each hop: the
 * unblock has already persisted by the time this runs, so a failed reopen is logged and swallowed
 * rather than failing the operation — re-running unblock retries it from wherever the sprint ended
 * up.
 *
 * Returns the `ConflictError` when the `done` hop was refused by the single-active-per-project
 * check, and `undefined` for every other outcome (reopened, nothing to reopen, or a failure the
 * operator can only act on via the log). Only the conflict is worth surfacing: it is the one case
 * where the sprint is left closed BY DESIGN and the operator has a concrete next action (close the
 * peer first).
 */
const reopenSprintIfReview = async (props: UnblockTaskProps, log: Logger): Promise<ConflictError | undefined> => {
  const loaded = await props.sprintRepo.findById(props.sprintId);
  if (!loaded.ok) {
    log.warn('could not load sprint to reopen after unblock', {
      sprintId: props.sprintId,
      error: loaded.error.message,
    });
    return undefined;
  }

  let sprint: Sprint = loaded.value;
  if (sprint.status === 'done') {
    // `review` holds the sprint branch checked out, so carrying a closed sprint back into it next
    // to a live peer would put two sprints of one project on the shared working tree — see the
    // invariant note in the use-case docblock. Same function `ralphctl sprint reopen` calls.
    // The verb is 'reopen', NOT 'unblock': it names the transition that is refused here. The
    // unblock itself has already succeeded by this point, so a log line or error message reading
    // "refusing to unblock" would tell the operator the opposite of what happened.
    const checked = await assertNoActivePeer(sprint, props.sprintRepo, log, 'reopen');
    if (!checked.ok) {
      // A ConflictError is the by-design refusal the caller must hear about; a StorageError is an
      // unreadable sprint list, which cannot establish that nobody holds the project either — the
      // hop is skipped both ways, but only the conflict names a peer and a next action.
      if (checked.error.code === 'conflict') return checked.error;
      log.warn('could not check for an active peer sprint after unblock', {
        sprintId: props.sprintId,
        error: checked.error.message,
      });
      return undefined;
    }
    const toReview = reopenDoneSprint(sprint, props.clock());
    if (!toReview.ok) {
      log.warn('could not reopen closed sprint after unblock', {
        sprintId: props.sprintId,
        error: toReview.error.message,
      });
      return undefined;
    }
    const persisted = await persistReopen(props, toReview.value, 'done → review', log);
    if (persisted === undefined) return undefined;
    sprint = persisted;
  }

  if (sprint.status !== 'review') return undefined;
  const toActive = revertSprintToActive(sprint, props.clock());
  if (!toActive.ok) {
    log.warn('could not reopen sprint after unblock', {
      sprintId: props.sprintId,
      error: toActive.error.message,
    });
    return undefined;
  }
  await persistReopen(props, toActive.value, 'review → active', log);
  return undefined;
};

/** Persist only the revived task via the single-task `update` — no whole-list rewrite needed. */
const persistPrimaryOnly = async (
  props: UnblockTaskProps,
  primary: TodoTask,
  log: Logger
): Promise<Result<UnblockTaskOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const persisted = await props.taskRepo.update(props.sprintId, primary);
  if (!persisted.ok) {
    log.error(PERSIST_FAILED_MSG, { taskId: primary.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }
  log.info(`unblocked task '${primary.name}'`, { taskId: primary.id, sprintId: props.sprintId });
  return Result.ok(outputWith(primary, await reopenSprintIfReview(props, log)));
};

/**
 * Rewrite the whole task list atomically so the primary AND its re-armed upstream-blocked
 * dependents land in one transaction.
 */
const persistCascade = async (
  props: UnblockTaskProps,
  primary: TodoTask,
  siblings: readonly Task[],
  dependentIds: ReadonlySet<Task['id']>,
  log: Logger
): Promise<Result<UnblockTaskOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const cascaded: TodoTask[] = [];
  const nextTasks = siblings.map((t) => {
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
  return Result.ok(outputWith(primary, await reopenSprintIfReview(props, log)));
};

export const unblockTaskUseCase = async (
  props: UnblockTaskProps
): Promise<Result<UnblockTaskOutput, InvalidStateError | NotFoundError | StorageError>> => {
  const log = props.logger.named('task.unblock');

  if (props.task.status === 'todo') {
    log.debug('already todo, skipping task transition', { taskId: props.task.id, sprintId: props.sprintId });
    return Result.ok(outputWith(props.task, await reopenSprintIfReview(props, log)));
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
    return persistPrimaryOnly(props, primary, log);
  }

  const dependentIds = new Set(upstreamBlockedDependents(all.value, primary.id));
  // Common case — no upstream-blocked dependents to re-arm.
  if (dependentIds.size === 0) return persistPrimaryOnly(props, primary, log);

  return persistCascade(props, primary, all.value, dependentIds, log);
};
