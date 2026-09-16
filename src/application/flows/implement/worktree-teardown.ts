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
import { gitDeleteBranch, gitHasUncommittedChanges, gitWorktreeRemove } from '@src/integration/io/git-operations.ts';

import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import {
  isSettledBlocked,
  runQuarantineBlockedDiff,
} from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import type { BuildWaveBranchesDeps } from '@src/application/flows/implement/wave-branch.ts';

/**
 * The worktree teardown, split out of `wave-branch.ts` as its own module (the same way
 * `worktree-fold.ts` is): deciding how a branch's task ended, quarantining a rejected diff,
 * choosing whether the throwaway ref survives, and removing the worktree is one self-contained
 * concern that `wave-branch.ts`'s `withWorktree` runs exactly once on every exit path.
 */

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
  readonly progressFile: AbsolutePath;
  readonly onTrace: OnTrace | undefined;
}

/**
 * How the branch's task ended, as far as the teardown can tell.
 *
 *  - `known`: `blocked` is the task's copy when it ended `blocked`; `quarantine` says whether that
 *    block may have left a rejected AI diff in the worktree.
 *  - `unknown`: no settled ctx reached the teardown AND the persisted task could not be read.
 */
type TaskOutcome =
  | { readonly kind: 'known'; readonly blocked: BlockedTask | undefined; readonly quarantine: boolean }
  | { readonly kind: 'unknown'; readonly error: DomainError };

/** `taskId`'s copy off a ctx, if it's there AND ended `blocked`. */
const findBlockedTask = (ctx: ImplementCtx, taskId: TaskId): BlockedTask | undefined => {
  const task = ctx.tasks?.find((t) => t.id === taskId);
  return task?.status === 'blocked' ? task : undefined;
};

/** A settled ctx is authoritative — the same `isSettledBlocked` gate the serial path's guard uses. */
const outcomeFromCtx = (ctx: ImplementCtx, taskId: TaskId): TaskOutcome => {
  const blocked = findBlockedTask(ctx, taskId);
  return { kind: 'known', blocked, quarantine: blocked !== undefined && isSettledBlocked(ctx, taskId) };
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
 * tree, a fresh worktree carries none, and the attempt may have restored an earlier rejected diff —
 * the worst case is a spurious stash, never lost work.
 */
const readPersistedOutcome = async (args: WorktreeTeardownArgs): Promise<TaskOutcome> => {
  const found = await findPersistedTask(args);
  if (!found.ok) return { kind: 'unknown', error: found.error };
  const task = found.value;
  if (task.status !== 'blocked') return { kind: 'known', blocked: undefined, quarantine: false };
  return { kind: 'known', blocked: task, quarantine: task.attempts.length > args.attemptsAtStart };
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
 * The fail-safe exit for an `unknown` outcome over a worktree that may hold work: leave the
 * worktree AND its ref on disk rather than guess. Removing it could destroy a rejected diff.
 * Stashing it blind has no blocked task to record the pointer on, and `restore-blocked-diff` could
 * then pop that stash into the next attempt of a task that may never have blocked. Leaving it
 * destroys nothing: the task's next launch fails loudly at `git worktree add` until the operator
 * has looked at the worktree and removed it, which the warning below spells out.
 */
const keepWorktreeForInspection = (args: WorktreeTeardownArgs, error: DomainError): void => {
  const worktreePath = String(args.worktreePath);
  args.deps.implement.logger.warn('worktree kept — could not read the task to tell whether it ended blocked', {
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
 * The worktree teardown — quarantine-if-blocked, then cleanup. Runs EXACTLY ONCE on EVERY exit path
 * of a branch: a settled result, a non-fatal failure, an abort, and a throw out of the body. The
 * once-ness is structural, not incidental — see the call sites in `wave-branch.ts`'s
 * `withWorktree`.
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
    keepWorktreeForInspection(args, outcome.error);
    return undefined;
  }
  const blocked = outcome.kind === 'known' ? outcome.blocked : undefined;
  const quarantined =
    blocked !== undefined && outcome.kind === 'known' && outcome.quarantine
      ? await quarantineDiff(args, blocked)
      : undefined;
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
 * persisted the pointer straight to `taskRepo` regardless. The epilogue rewrites such a task back to
 * its pre-wave copy, which drops that pointer again — the stash itself (found by its deterministic
 * message, both by `git stash list` and by `restore-blocked-diff` on the task's next attempt) and
 * the `progress.md` breadcrumb are what survive.
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
    //  - `task-blocked`: the branch completed, so `captureDurableFold` recorded the settled task and
    //    the epilogue persists it — the SHA `commitTaskUseCase` wrote is still in `tasks.json` (an
    //    operator unblock archives the attempts into `retiredAttempts` rather than deleting them)
    //    AND on `progress.md`'s `- Commit: <sha>` line.
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
