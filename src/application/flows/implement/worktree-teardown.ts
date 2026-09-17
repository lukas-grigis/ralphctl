import { Result } from '@src/domain/result.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

import type { ElementResult } from '@src/application/chain/element.ts';
import type { OnTrace } from '@src/application/chain/trace.ts';
import {
  gitDeleteBranch,
  gitHasUncommittedChanges,
  gitStashList,
  gitStashPush,
  gitWorktreeRemove,
  stashEntryMatchesMessage,
} from '@src/integration/io/git-operations.ts';

import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import {
  isSettledBlocked,
  quarantineStashMessage,
  runQuarantineBlockedDiff,
} from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import type { BuildWaveBranchesDeps } from '@src/application/flows/implement/wave-branch.ts';

/**
 * The worktree teardown, split out of `wave-branch.ts` as its own module (the same way
 * `worktree-fold.ts` is): deciding how a branch's task ended, quarantining a rejected diff,
 * re-stashing a restored diff an interrupted attempt left behind, choosing whether the throwaway ref
 * survives, and removing the worktree is one self-contained concern that `wave-branch.ts`'s
 * `withWorktree` runs exactly once on every exit path.
 */

/**
 * How many stash entries sit under `message` — `taskId`'s quarantine key — in `listed`. The key can
 * hold more than one: when a restore's pop fails, git keeps the entry, and the block that attempt
 * then reaches quarantines a second diff under the same message.
 */
const countQuarantined = (listed: readonly string[], message: string): number =>
  listed.filter((entry) => stashEntryMatchesMessage(entry, message)).length;

/**
 * How many entries `taskId`'s quarantine key holds in the stash right now — taken once when a branch
 * starts, before anything in it can pop one (see {@link WorktreeTeardownArgs}). The stash is shared
 * by every worktree of the repo, so the main repo's listing is the worktree's too.
 *
 * A failed listing counts as zero: the teardown then behaves as it did before it knew about
 * restored diffs, which is also what it does for every branch whose task had nothing quarantined.
 */
export const snapshotQuarantinedDiff = async (
  deps: BuildWaveBranchesDeps,
  repoRoot: AbsolutePath,
  sprintId: SprintId,
  taskId: TaskId
): Promise<number> => {
  const listed = await gitStashList(deps.implement.gitRunner, repoRoot);
  if (listed.ok) return countQuarantined(listed.value, quarantineStashMessage(sprintId, taskId));
  deps.implement.logger.warn(
    "stash list failed at branch start — a restored diff can't be re-stashed if this branch is interrupted",
    {
      taskId: String(taskId),
      error: listed.error.message,
    }
  );
  return 0;
};

/** Everything the worktree teardown needs, closed over once per branch execution. */
export interface WorktreeTeardownArgs {
  readonly deps: BuildWaveBranchesDeps;
  readonly repoRoot: AbsolutePath;
  readonly worktreePath: AbsolutePath;
  readonly branchRef: string;
  readonly taskId: TaskId;
  readonly sprintId: SprintId;
  /** Attempts the task carried when the branch started — see {@link readPersistedOutcome}. */
  readonly attemptsAtStart: number;
  /**
   * How many entries the task's quarantine key held in the stash when the branch started
   * ({@link snapshotQuarantinedDiff}). Only an entry listed then can an attempt of this branch have
   * popped into the worktree — see {@link requarantineRestoredDiff}.
   */
  readonly quarantinedAtStart: number;
  readonly progressFile: AbsolutePath;
  readonly onTrace: OnTrace | undefined;
}

/**
 * How the branch's task ended, as far as the teardown can tell.
 *
 *  - `known`: `blocked` is the task's copy when it ended `blocked`; `quarantine` says whether that
 *    block may have left a rejected AI diff in the worktree; `restoredDiffAtRisk` says whether the
 *    last attempt this branch opened was interrupted before it committed anything, so a diff
 *    `restore-blocked-diff` popped may still sit in the worktree with no other copy.
 *  - `unknown`: no settled ctx reached the teardown AND the persisted task could not be read.
 */
type TaskOutcome =
  | {
      readonly kind: 'known';
      readonly blocked: BlockedTask | undefined;
      readonly quarantine: boolean;
      readonly restoredDiffAtRisk: boolean;
    }
  | { readonly kind: 'unknown'; readonly error: DomainError };

/** `taskId`'s copy off a ctx, if it's there AND ended `blocked`. */
const findBlockedTask = (ctx: ImplementCtx, taskId: TaskId): BlockedTask | undefined => {
  const task = ctx.tasks?.find((t) => t.id === taskId);
  return task?.status === 'blocked' ? task : undefined;
};

/**
 * A settled ctx is authoritative — the same `isSettledBlocked` gate the serial path's guard uses. A
 * subchain that settled consumed any diff it restored: the restore only runs when a generator turn
 * follows, so that diff was committed, stashed for a granted retry, or blocked with a turn on
 * record, which this `quarantine` covers.
 */
const outcomeFromCtx = (ctx: ImplementCtx, taskId: TaskId): TaskOutcome => {
  const blocked = findBlockedTask(ctx, taskId);
  return {
    kind: 'known',
    blocked,
    quarantine: blocked !== undefined && isSettledBlocked(ctx, taskId),
    restoredDiffAtRisk: false,
  };
};

/**
 * Read the persisted task. A THROW out of the adapter counts as a failed read, so it lands on the
 * same fail-safe path instead of replacing the branch's own result (an in-flight `AbortError`
 * included) with a raw error and skipping the rest of the teardown. `AbortError` itself is exempt.
 */
const findPersistedTask = async (args: WorktreeTeardownArgs): Promise<Result<Task, NotFoundError | StorageError>> => {
  try {
    return await args.deps.implement.taskRepo.findById(args.sprintId, args.taskId);
  } catch (error) {
    if (error instanceof AbortError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return Result.error(new StorageError({ subCode: 'io', message: `task lookup threw: ${detail}`, cause: error }));
  }
};

/**
 * The outcome when no settled ctx reached the teardown. The real subchain is `sequential` / `loop`
 * all the way down, and `settle-attempt` persists `blocked` BEFORE append-learnings,
 * progress-journal and the uninstall leaves run — an abort landing in any of them makes the
 * subchain return `Result.error` with no ctx at all. The persisted task is then the truth.
 *
 * `quarantine` is `isSettledBlocked`'s zero-turn gate at the granularity the disk records: only a
 * block this branch reached AFTER opening an attempt can hold AI work. The dependency gate and
 * resume recovery block without opening one, so their worktree holds setup-script output at most.
 * A block inside an opened attempt IS quarantined even when zero turns ran (the persisted task
 * can't tell), which is the safe side: that gate protects operator WIP in the serial path's shared
 * tree, a fresh worktree carries none, and whatever the worktree holds past setup is the attempt's
 * own — the worst case is a spurious stash, never lost work.
 *
 * A task still `in_progress` was interrupted mid-attempt. `restoredDiffAtRisk` is set when the
 * last attempt this branch opened recorded no commit: the restore runs after that attempt's
 * `start-attempt`, so a diff it popped is still uncommitted in the worktree. An EARLIER attempt's
 * commit says nothing about it — attempt 1 can commit the entry it popped, and attempt 2 can pop
 * another entry under the same key and be interrupted.
 */
const readPersistedOutcome = async (args: WorktreeTeardownArgs): Promise<TaskOutcome> => {
  const found = await findPersistedTask(args);
  if (!found.ok) return { kind: 'unknown', error: found.error };
  const task = found.value;
  const opened = task.attempts.slice(args.attemptsAtStart);
  if (task.status !== 'blocked') {
    const lastOpened = opened.at(-1);
    const interruptedUncommitted =
      task.status === 'in_progress' && lastOpened !== undefined && lastOpened.commitSha === undefined;
    return { kind: 'known', blocked: undefined, quarantine: false, restoredDiffAtRisk: interruptedUncommitted };
  }
  return { kind: 'known', blocked: task, quarantine: opened.length > 0, restoredDiffAtRisk: false };
};

/**
 * Prefer the body's own returned ctx when the branch completed; fall back to the side-channel ctx
 * (captured before the fold step ran) when the overall result is an error or a throw; fall back to
 * the persisted task when neither exists.
 */
const resolveOutcome = async (
  args: WorktreeTeardownArgs,
  result: ElementResult<ImplementCtx> | undefined,
  settledCtx: ImplementCtx | undefined
): Promise<TaskOutcome> => {
  const ctx = result?.ok === true ? result.value.ctx : settledCtx;
  return ctx !== undefined ? outcomeFromCtx(ctx, args.taskId) : readPersistedOutcome(args);
};

/** `true` unless the worktree is verifiably clean — a failed status check counts as "may hold work". */
const worktreeMayHoldWork = async (args: WorktreeTeardownArgs): Promise<boolean> => {
  const dirty = await gitHasUncommittedChanges(args.deps.implement.gitRunner, args.worktreePath);
  return !dirty.ok || dirty.value;
};

/**
 * The fail-safe exit whenever the teardown can't tell that removing the worktree destroys nothing:
 * leave the worktree AND its ref on disk rather than guess. `reason` names what it couldn't tell.
 *
 *  - An `unknown` outcome over a worktree that may hold work. Removing it could destroy a rejected
 *    diff. Stashing it blind has no blocked task to record the pointer on, and `restore-blocked-diff`
 *    could then pop that stash into the next attempt of a task that may never have blocked.
 *  - A restored diff {@link requarantineRestoredDiff} could not confirm is back in the stash.
 *
 * Leaving it destroys nothing: the task's next launch fails loudly at `git worktree add` until the
 * operator has looked at the worktree and removed it, which the warning below spells out.
 */
const keepWorktreeForInspection = (args: WorktreeTeardownArgs, error: DomainError, reason: string): void => {
  const worktreePath = String(args.worktreePath);
  args.deps.implement.logger.warn(`worktree kept — ${reason}`, {
    taskId: String(args.taskId),
    worktreePath,
    branchRef: args.branchRef,
    error: error.message,
    hint: `inspect the uncommitted changes in '${worktreePath}', then run \`git worktree remove --force ${worktreePath}\` before relaunching this task`,
  });
  args.onTrace?.({ elementName: `worktree-cleanup-${String(args.taskId)}`, status: 'failed', durationMs: 0, error });
};

/**
 * Stash the blocked task's rejected diff under the deterministic message BEFORE the worktree is
 * destroyed. Run with `cwd` = the WORKTREE (that's where the uncommitted diff physically sits) —
 * worktrees share `.git` with the main repo, so the resulting stash survives
 * `git worktree remove --force` (verified with a throwaway repo: create a worktree, dirty it,
 * `git stash push` from inside it, `git worktree remove --force`, then `git stash list` /
 * `git stash pop` from the main repo — the entry and its content both survive). Best-effort: a
 * failure is logged at `warn` and never fails the branch — see `runQuarantineBlockedDiff`. Pure
 * local git work with no signal-aware waiting of its own, so it runs on an abort too.
 *
 * Returns the task copy carrying the recovery pointer when a capture actually happened.
 */
const quarantineDiff = async (args: WorktreeTeardownArgs, task: BlockedTask): Promise<BlockedTask | undefined> => {
  const { deps, taskId } = args;
  const start = performance.now();
  const outcome = await runQuarantineBlockedDiff(
    {
      gitRunner: deps.implement.gitRunner,
      taskRepo: deps.implement.taskRepo,
      appendFile: deps.implement.appendFile,
      logger: deps.implement.logger,
    },
    { cwd: args.worktreePath, progressFile: args.progressFile },
    { task, sprintId: args.sprintId },
    taskId
  );
  args.onTrace?.({
    elementName: `quarantine-blocked-diff-${String(taskId)}`,
    status: 'completed',
    durationMs: performance.now() - start,
  });
  return outcome.ok ? outcome.value : undefined;
};

/**
 * Put a diff `restore-blocked-diff` popped back in the stash before an interrupted branch's worktree
 * is removed. A successful pop drops the stash entry, so the worktree holds the only copy, and an
 * abort / error / throw that lands before the attempt commits it or quarantines it again leaves the
 * persisted task `in_progress` — no block for the regular quarantine to act on.
 *
 * Runs against the WORKTREE (where the diff sits; the stash itself is shared with the main repo),
 * and compares how many entries the task's key holds now with {@link WorktreeTeardownArgs}'s
 * `quarantinedAtStart`:
 *  - as many as at branch start → nothing was popped (the restore found a dirty tree, conflicted,
 *    or never ran), so there is nothing to put back;
 *  - fewer → an attempt popped one, so `git stash push -u` under the same message — a no-op on a
 *    clean tree. It also takes whatever the interrupted attempt wrote on top, since the two can't be
 *    told apart; the next attempt resumes from both.
 *
 * A count, not "is any entry listed": the key can hold several entries, the pop takes the newest,
 * and an older one still listed says nothing about the one that left. The count is exact because
 * nothing else moves this key while the branch runs. Keys are per task, a launch runs one branch per
 * task, siblings only push and pop their own keys, and the only push under this key on the parallel
 * path is the teardown's own — the blocked-task quarantine, which never runs together with this.
 *
 * No `blockedReason` pointer is written — the task isn't blocked — and the journal breadcrumb from
 * the original quarantine already names the same key. A failed listing or push returns the error:
 * the caller then keeps the worktree instead of removing a diff it could not save.
 */
const requarantineRestoredDiff = async (args: WorktreeTeardownArgs): Promise<Result<void, StorageError>> => {
  const { gitRunner, logger } = args.deps.implement;
  const message = quarantineStashMessage(args.sprintId, args.taskId);
  const listed = await gitStashList(gitRunner, args.worktreePath);
  if (!listed.ok) return Result.error(listed.error);
  if (countQuarantined(listed.value, message) >= args.quarantinedAtStart) return Result.ok(undefined);
  const pushed = await gitStashPush(gitRunner, args.worktreePath, message);
  if (!pushed.ok) return Result.error(pushed.error);
  if (pushed.value.stashed) {
    logger.warn("interrupted attempt's restored diff re-quarantined", {
      taskId: String(args.taskId),
      stashMessage: message,
    });
  }
  return Result.ok(undefined);
};

/**
 * `true` when the worktree is safe to remove as far as a restored diff goes: nothing was at risk,
 * or {@link requarantineRestoredDiff} put it back. `false` after keeping the worktree instead.
 */
const protectRestoredDiff = async (args: WorktreeTeardownArgs, atRisk: boolean): Promise<boolean> => {
  if (!atRisk || args.quarantinedAtStart === 0) return true;
  const saved = await requarantineRestoredDiff(args);
  if (saved.ok) return true;
  keepWorktreeForInspection(
    args,
    saved.error,
    "could not confirm an interrupted attempt's restored diff is back in the stash"
  );
  return false;
};

/**
 * The worktree teardown — quarantine-if-blocked, re-stash an interrupted attempt's restored diff,
 * then cleanup. Runs EXACTLY ONCE on EVERY exit path of a branch: a settled result, a non-fatal
 * failure, an abort, and a throw out of the body. The once-ness is structural, not incidental — see
 * the call sites in `wave-branch.ts`'s `withWorktree`.
 *
 * `result` is the branch's own outcome, or `undefined` when the body THREW. It is a PARAMETER
 * rather than a definite-assignment `let` read from an enclosing `finally` for exactly that case:
 * the chain primitives re-throw every non-DomainError verbatim (`leaf.ts`) and `buildSubchain` is
 * constructed inside the body, so the throw path is reachable from any projection bug — and
 * dereferencing an unassigned `result` there would replace the original error with a `TypeError`
 * AND skip the cleanup, leaving the worktree dir + its ref on disk so every later launch of that
 * task fails in `git worktree add`.
 *
 * `result` itself is never touched here, so an in-flight `AbortError` keeps propagating verbatim
 * once this returns. Returns the quarantined task copy when a capture actually happened, for
 * {@link foldQuarantinePointer} to fold back into a successful result.
 */
export const teardownWorktree = async (
  args: WorktreeTeardownArgs,
  result: ElementResult<ImplementCtx> | undefined,
  settledCtx: ImplementCtx | undefined
): Promise<BlockedTask | undefined> => {
  const outcome = await resolveOutcome(args, result, settledCtx);
  if (outcome.kind === 'unknown' && (await worktreeMayHoldWork(args))) {
    keepWorktreeForInspection(args, outcome.error, 'could not read the task to tell whether it ended blocked');
    return undefined;
  }
  const blocked = outcome.kind === 'known' ? outcome.blocked : undefined;
  const quarantined =
    blocked !== undefined && outcome.kind === 'known' && outcome.quarantine
      ? await quarantineDiff(args, blocked)
      : undefined;
  if (!(await protectRestoredDiff(args, outcome.kind === 'known' && outcome.restoredDiffAtRisk))) return undefined;
  // Cleanup runs on every other path — success, non-fatal failure, abort, or throw. The worktree's
  // commits are already folded by the body's fold step (or this ref is the only place they live, if
  // the fold itself is what blocked the task, or never ran to completion at all), so a forced remove
  // only ever drops scratch state — and the ref outlives it whenever `keepBranchRefReason` says so.
  await cleanupWorktree(args, keepBranchRefReason(blocked !== undefined, result));
  return quarantined;
};

/**
 * Fold the updated `blockedReason` (the recovery pointer, on a real capture — `runQuarantineBlocked-
 * Diff` never errors, see its docstring) back into the returned ctx so the wave merge / epilogue save
 * persists the SAME pointer `recordQuarantineUseCase` already wrote to disk — otherwise the
 * epilogue's later `tasks.json` write would clobber it. Only meaningful on a successful result: an
 * errored / aborted / thrown one has no ctx slot to fold into, and `recordQuarantineUseCase` already
 * persisted the pointer straight to `taskRepo` regardless. On THAT path (the branch's overall result
 * errors or aborts after the pointer already landed on disk), `mergeImplementWave` contributes
 * nothing for this branch, so the epilogue's `adopt-persisted-blocks` leaf is what re-reads the
 * persisted block AND its pointer before `saveTasksLeaf` runs — neither is simply dropped anymore.
 */
export const foldQuarantinePointer = (
  result: ElementResult<ImplementCtx>,
  quarantined: BlockedTask | undefined
): ElementResult<ImplementCtx> => {
  if (!result.ok || quarantined === undefined) return result;
  const tasks = (result.value.ctx.tasks ?? []).map((t) => (t.id === quarantined.id ? quarantined : t));
  return Result.ok({ ctx: { ...result.value.ctx, tasks }, trace: result.value.trace });
};

/**
 * Why cleanup must KEEP the throwaway `wt-<task>` ref instead of deleting it — `undefined` when it
 * is free to drop it.
 *
 *  - `task-blocked`: a fold-conflict block re-projects an already-`done` task back to `blocked`
 *    AFTER its commits landed on THIS ref, so deleting it would leave verified, committed work
 *    reachable only via reflog until GC (the `blockedReason` literally names this ref). An
 *    own-failure block (setup script / attempt-loop self-block) may have nothing of value on the
 *    ref, but keeping it uniformly is cheap.
 *  - `fold-incomplete`: the branch never completed its fold — it errored (an abort: `foldStep`
 *    returns `abortedStep` BEFORE folding, so a task that already settled `done` still has its
 *    verified commits on this ref and nowhere else) or it threw. `captureDurableFold` records only
 *    a `completed` branch, so the epilogue rewrites that task back to its pre-wave status and the
 *    relaunch re-runs it from scratch; keeping the ref is what lets an operator cherry-pick the
 *    work instead of paying a second full generator/evaluator spend for it.
 */
type KeepBranchRefReason = 'task-blocked' | 'fold-incomplete';

const keepBranchRefReason = (
  taskEndedBlocked: boolean,
  result: ElementResult<ImplementCtx> | undefined
): KeepBranchRefReason | undefined => {
  if (taskEndedBlocked) return 'task-blocked';
  return result === undefined || !result.ok ? 'fold-incomplete' : undefined;
};

const cleanupWorktree = async (args: WorktreeTeardownArgs, keep: KeepBranchRefReason | undefined): Promise<void> => {
  const { deps, repoRoot, worktreePath, branchRef, taskId, onTrace } = args;
  const { gitRunner, logger } = deps.implement;
  const name = `worktree-cleanup-${String(taskId)}`;
  const start = performance.now();
  const removed = await gitWorktreeRemove(gitRunner, repoRoot, worktreePath);
  const durationMs = performance.now() - start;
  if (!removed.ok) {
    // Best-effort: a left-over worktree is scratch (commits already folded). Surface as a warn so
    // the operator can prune it manually, but never fail the branch over teardown.
    logger.warn('worktree cleanup failed', {
      taskId: String(taskId),
      worktreePath: String(worktreePath),
      error: removed.error.message,
    });
    onTrace?.({ elementName: name, status: 'failed', durationMs, error: removed.error });
    return;
  }
  if (keep !== undefined) {
    // Keeping the ref buys a recovery WINDOW, not permanence, and the window is exactly one launch
    // wide: `setupWorktree`'s defensive `gitDeleteBranch` (`git branch -D`, in `wave-branch.ts`)
    // drops the ref unconditionally the next time THIS task starts — which for a blocked task is
    // the first relaunch after the operator unblocks it. Past that point the commit survives only
    // through its SHA, and WHERE that SHA still is depends on which reason kept the ref:
    //  - `task-blocked`: whether the branch itself completed (a fold conflict, `captureDurableFold`
    //    records the settled task and the epilogue persists it directly) or errored/aborted AFTER a
    //    leaf had already persisted the block (`adopt-persisted-blocks` re-reads it into the epilogue
    //    — see that leaf and `foldQuarantinePointer`'s docstring) — the SHA `commitTaskUseCase` wrote
    //    is still in `tasks.json` (an operator unblock archives the attempts into `retiredAttempts`
    //    rather than deleting them) AND on `progress.md`'s `- Commit: <sha>` line.
    //  - `fold-incomplete`: the branch never emitted `completed`, so `captureDurableFold` skips it
    //    and the epilogue writes that task back to its PRE-WAVE copy — clobbering the mid-run
    //    attempt row that held `commitSha`. `progress.md`'s `- Commit:` line is then the only
    //    surviving handle, and it is truncated to `SHA_DISPLAY_LENGTH` (7) chars by
    //    `render-journal-entry.ts`; `git cherry-pick <short sha>` still resolves it.
    // Either way the cherry-pick works only until gc prunes the now-unreachable object.
    logger.warn('worktree branch kept', { taskId: String(taskId), branchRef, reason: keep });
    onTrace?.({ elementName: name, status: 'completed', durationMs });
    return;
  }
  // `worktree remove` leaves the throwaway `wt-<task>` branch ref behind; drop it so a relaunch
  // can recreate the worktree with `add -b <same-ref>`. Best-effort — a surviving ref is harmless
  // scratch (the commit is already folded), so a delete failure is logged, never fatal.
  const branchDeleted = await gitDeleteBranch(gitRunner, repoRoot, branchRef);
  if (!branchDeleted.ok) {
    logger.warn('worktree branch cleanup failed', {
      taskId: String(taskId),
      branchRef,
      error: branchDeleted.error.message,
    });
  }
  onTrace?.({ elementName: name, status: 'completed', durationMs });
};
