import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { SaveAllTasks } from '@src/domain/repository/task/save-all-tasks.ts';
import type { Task, TodoTask } from '@src/domain/entity/task.ts';
import { resetTaskToTodo, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import { upstreamBlockedDependents } from '@src/domain/entity/task-graph.ts';
import {
  type ActiveSprint,
  type DoneSprint,
  reopenDoneSprint,
  type ReviewSprint,
  type Sprint,
  revertSprintToActive,
} from '@src/domain/entity/sprint.ts';
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

type UnblockTaskError = InvalidStateError | NotFoundError | StorageError;

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
 * **Sprint reopen.** The implement gate only runs `planned` / `active` sprints, so reviving a task
 * on a settled sprint would strand it. A mixed run (some tasks `done`, some `blocked`) settles the
 * sprint to `review`; the operator may also have closed it to `done` with the task still blocked.
 * Reviving the task therefore reopens the sprint, in two hops placed around the task write:
 *
 * - `done` → `review` ({@link reopenDoneSprint}) runs BEFORE the task write, and is part of the
 *   unblock: if the sprint can't be loaded, the peer check can't read the sprint list, or the hop
 *   can't be persisted, the unblock fails with the task untouched. If the task write then fails,
 *   the sprint is put back to `done`. A process that dies between the two writes leaves a
 *   `review` sprint with the task still blocked — the state a mixed run settles to — and a retry
 *   walks the whole path again.
 * - `review` → `active` ({@link revertSprintToActive}) runs AFTER the task write and is
 *   best-effort: a failure is logged, not returned, because the task is already revived. A retry
 *   then sees a `todo` task on a `review` sprint, and the already-`todo` short-circuit finishes the
 *   hop. That is the ONLY reopen the short-circuit performs. A `review` sprint holding `todo` work
 *   is not review-complete, so reopening it is always right. A `done` sprint holding `todo` work
 *   was closed that way on purpose (the first hop runs before the task write, so an interrupted
 *   unblock never leaves that state). An unblock that revives nothing must not undo that close.
 *
 * Every reopen this call performs rides out on {@link UnblockTaskOutput.sprintReopened}, so the
 * CLI / TUI can tell the operator a settled sprint is open again.
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
 * tell the operator the sprint stayed closed and which peer holds the project. Once the peer is
 * closed, `ralphctl sprint reopen` followed by another unblock of the (now `todo`) task finishes
 * the job — re-running unblock alone does not, per the short-circuit rule above.
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
   * Used to reopen a `done` / `review` sprint once there is `todo` work again. `list` is the peer
   * check's read — reopening a `done` sprint is subject to the single-active-per-project
   * invariant, which can only be answered by scanning the project's other sprints.
   */
  readonly sprintRepo: FindById<Sprint, SprintId> & Save<Sprint> & ListAll<Sprint>;
  /** Wall-clock for the reopen's lifecycle re-stamps. */
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

/** A reopen this unblock call performed — or attempted and left unfinished. */
export interface SprintReopened {
  /** Where the sprint stood before this call. */
  readonly from: 'done' | 'review';
  /**
   * The sprint as persisted. `active` normally; a `review` sprint in two cases, both meaning the
   * `review` → `active` step did not persist: a closed sprint's `done` → `review` hop landed but
   * the second hop failed (`from: 'done'`), or the sprint was already `review` when this call
   * started and the same hop failed again on this attempt (`from: 'review'`). Either way
   * `sprint.status === 'review'` here is the caller's signal that nothing was actually resolved —
   * re-running unblock retries the hop.
   */
  readonly sprint: ActiveSprint | ReviewSprint;
}

export interface UnblockTaskOutput {
  /** The revived task. Always present — every reopen outcome below is reported, not failed. */
  readonly task: TodoTask;
  /**
   * Set whenever this call moved a settled sprint back toward `active`. Reopening a sprint changes
   * what the operator can do with it (a closed sprint holds the project again), so it must never
   * happen without the CLI / TUI saying so.
   */
  readonly sprintReopened?: SprintReopened;
  /**
   * Set when the sprint stayed closed because another sprint of the same project is already
   * `active` / `review`. The unblock itself succeeded; this is the operator-facing "and the sprint
   * did NOT reopen, because …" half, which would otherwise be visible only in a log line the CLI
   * never renders (`bootstrapCli` attaches no log subscriber).
   */
  readonly sprintReopenConflict?: ConflictError;
}

/** Assemble the output envelope — each optional key is omitted entirely when it has no value. */
const outputOf = (
  task: TodoTask,
  sprintReopened: SprintReopened | undefined,
  sprintReopenConflict: ConflictError | undefined
): UnblockTaskOutput => ({
  task,
  ...(sprintReopened !== undefined ? { sprintReopened } : {}),
  ...(sprintReopenConflict !== undefined ? { sprintReopenConflict } : {}),
});

/**
 * Where the sprint stands once the pre-write hop has run. `reopened` carries the closed sprint it
 * replaced, so a failed task write can put it back.
 */
type SprintBeforeRevive =
  | { readonly kind: 'as-loaded'; readonly sprint: Sprint; readonly conflict?: ConflictError }
  | { readonly kind: 'reopened'; readonly sprint: ReviewSprint; readonly closed: DoneSprint };

/**
 * Load the sprint and, when it is `done`, carry it to `review` — BEFORE the task write, see the
 * use-case docblock. Every failure is returned so the caller revives nothing. The one exception is
 * the single-active-per-project refusal, which skips the hop by design and is handed back as data.
 */
const reopenClosedSprint = async (
  props: UnblockTaskProps,
  log: Logger
): Promise<Result<SprintBeforeRevive, UnblockTaskError>> => {
  const loaded = await props.sprintRepo.findById(props.sprintId);
  if (!loaded.ok) {
    log.error('could not load sprint — task left as is', { sprintId: props.sprintId, error: loaded.error.message });
    return Result.error(loaded.error);
  }
  const sprint = loaded.value;
  if (sprint.status !== 'done') return Result.ok({ kind: 'as-loaded', sprint });

  // `review` holds the sprint branch checked out, so carrying a closed sprint back into it next
  // to a live peer would put two sprints of one project on the shared working tree — see the
  // invariant note in the use-case docblock. Same function `ralphctl sprint reopen` calls.
  // The verb is 'reopen', NOT 'unblock': it names the transition that is refused here. The task
  // is still revived on a conflict, so a log line or error message reading "refusing to unblock"
  // would tell the operator the opposite of what happened.
  const checked = await assertNoActivePeer(sprint, props.sprintRepo, log, 'reopen');
  if (!checked.ok) {
    if (checked.error.code === 'conflict') return Result.ok({ kind: 'as-loaded', sprint, conflict: checked.error });
    // An unreadable sprint list cannot establish that nobody holds the project either.
    log.error('could not check for an active peer sprint — task left blocked', {
      sprintId: props.sprintId,
      error: checked.error.message,
    });
    return Result.error(checked.error);
  }

  const toReview = reopenDoneSprint(sprint, props.clock());
  if (!toReview.ok) return Result.error(toReview.error);
  const saved = await props.sprintRepo.save(toReview.value);
  if (!saved.ok) {
    log.error('could not reopen closed sprint — task left blocked', {
      sprintId: props.sprintId,
      error: saved.error.message,
    });
    return Result.error(saved.error);
  }
  log.info(`sprint '${toReview.value.slug}' reopened done → review to resume unblocked work`, {
    sprintId: props.sprintId,
  });
  return Result.ok({ kind: 'reopened', sprint: toReview.value, closed: sprint });
};

/** The task write failed after the `done` → `review` hop landed: put the closed sprint back. */
const restoreClosedSprint = async (props: UnblockTaskProps, closed: DoneSprint, log: Logger): Promise<void> => {
  const restored = await props.sprintRepo.save(closed);
  if (!restored.ok) {
    log.warn('could not put the sprint back to done after the unblock failed', {
      sprintId: props.sprintId,
      error: restored.error.message,
    });
  }
};

/**
 * `review` → `active`, AFTER the task write. Best-effort: the task is already revived, so a failure
 * is logged and swallowed — the already-`todo` short-circuit retries it. Returns the persisted
 * active sprint, or `undefined` when nothing was reopened.
 */
const activateReviewSprint = async (
  props: UnblockTaskProps,
  sprint: Sprint,
  log: Logger
): Promise<ActiveSprint | undefined> => {
  if (sprint.status !== 'review') return undefined;
  const toActive = revertSprintToActive(sprint, props.clock());
  if (!toActive.ok) {
    log.warn('could not reopen sprint after unblock', { sprintId: props.sprintId, error: toActive.error.message });
    return undefined;
  }
  const saved = await props.sprintRepo.save(toActive.value);
  if (!saved.ok) {
    log.warn('could not persist reopened sprint after unblock', {
      sprintId: props.sprintId,
      hop: 'review → active',
      error: saved.error.message,
    });
    return undefined;
  }
  log.info(`sprint '${toActive.value.slug}' reopened review → active to resume unblocked work`, {
    sprintId: props.sprintId,
  });
  return toActive.value;
};

/**
 * The already-`todo` leg: finish an interrupted `review` → `active` hop, and nothing else — see the
 * use-case docblock for why a `done` sprint is left closed here. Best-effort throughout, like the
 * hop it retries.
 */
const finishInterruptedReopen = async (
  props: UnblockTaskProps,
  task: TodoTask,
  log: Logger
): Promise<Result<UnblockTaskOutput, UnblockTaskError>> => {
  log.debug('already todo, skipping task transition', { taskId: task.id, sprintId: props.sprintId });
  const loaded = await props.sprintRepo.findById(props.sprintId);
  if (!loaded.ok) {
    log.warn('could not load sprint to reopen after unblock', {
      sprintId: props.sprintId,
      error: loaded.error.message,
    });
    return Result.ok(outputOf(task, undefined, undefined));
  }
  const active = await activateReviewSprint(props, loaded.value, log);
  // `activateReviewSprint` no-ops (returns `undefined`) both when the sprint isn't `review` (this
  // short-circuit only ever reopens a `review` sprint, so that can't happen here) and when the
  // hop failed to persist. Report the still-`review` sprint in the latter case so the caller never
  // renders a plain success while the retry hop is still stuck — see `SprintReopened`'s doc
  // comment.
  const reopened: SprintReopened | undefined =
    active !== undefined
      ? { from: 'review', sprint: active }
      : loaded.value.status === 'review'
        ? { from: 'review', sprint: loaded.value }
        : undefined;
  return Result.ok(outputOf(task, reopened, undefined));
};

/** Persist only the revived task via the single-task `update` — no whole-list rewrite needed. */
const persistPrimaryOnly = async (
  props: UnblockTaskProps,
  primary: TodoTask,
  log: Logger
): Promise<Result<undefined, NotFoundError | StorageError>> => {
  const persisted = await props.taskRepo.update(props.sprintId, primary);
  if (!persisted.ok) {
    log.error(PERSIST_FAILED_MSG, { taskId: primary.id, error: persisted.error.message });
    return Result.error(persisted.error);
  }
  log.info(`unblocked task '${primary.name}'`, { taskId: primary.id, sprintId: props.sprintId });
  return Result.ok(undefined);
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
): Promise<Result<undefined, StorageError>> => {
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
  return Result.ok(undefined);
};

/** Persist the revived task, cascading to the dependency-gate subtree it rooted when there is one. */
const persistRevived = async (
  props: UnblockTaskProps,
  primary: TodoTask,
  log: Logger
): Promise<Result<undefined, NotFoundError | StorageError>> => {
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

export const unblockTaskUseCase = async (
  props: UnblockTaskProps
): Promise<Result<UnblockTaskOutput, UnblockTaskError>> => {
  const log = props.logger.named('task.unblock');

  if (props.task.status === 'todo') return finishInterruptedReopen(props, props.task, log);

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

  const before = await reopenClosedSprint(props, log);
  if (!before.ok) return Result.error(before.error);

  const persisted = await persistRevived(props, primary, log);
  if (!persisted.ok) {
    if (before.value.kind === 'reopened') await restoreClosedSprint(props, before.value.closed, log);
    return Result.error(persisted.error);
  }

  const active = await activateReviewSprint(props, before.value.sprint, log);
  if (before.value.kind === 'reopened') {
    return Result.ok(outputOf(primary, { from: 'done', sprint: active ?? before.value.sprint }, undefined));
  }
  // The sprint was already `review` (not `done`) when loaded — no first hop was needed. If the
  // second hop still failed to persist, report the residual `review` sprint (see
  // `SprintReopened`'s doc comment) so the caller never shows a plain success while the sprint is
  // still stuck short of `active`. A conflict-refused `done` sprint stays `done`, not `review`, so
  // this branch never fires for that case — `sprintReopenConflict` alone reports it.
  const reopened: SprintReopened | undefined =
    active !== undefined
      ? { from: 'review', sprint: active }
      : before.value.sprint.status === 'review'
        ? { from: 'review', sprint: before.value.sprint }
        : undefined;
  return Result.ok(outputOf(primary, reopened, before.value.conflict));
};
