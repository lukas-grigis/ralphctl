import { Result } from '@src/domain/result.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { join } from 'node:path';

import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { OnTrace, TraceEntry } from '@src/application/chain/trace.ts';
import type { WaveBranch } from '@src/application/chain/run/wave-scheduler.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { createPublishSignal, type PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import {
  gitDeleteBranch,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRef,
  gitWorktreeRemove,
} from '@src/integration/io/git-operations.ts';

import type { AppendFile } from '@src/business/io/append-file.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { CreateImplementFlowOpts, RepoExecConfig } from '@src/application/flows/implement/flow.ts';
import { forkCtx } from '@src/application/flows/implement/merge-wave.ts';
import { resolveRepoOrThrow } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import {
  createPerTaskSubchain,
  type PerTaskSubchainOpts,
} from '@src/application/flows/implement/leaves/per-task-subchain.ts';
import {
  isSettledBlocked,
  runQuarantineBlockedDiff,
} from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import { abortedStep, foldStep } from '@src/application/flows/implement/worktree-fold.ts';

/**
 * Async mutex serialising worktree folds onto the shared sprint branch. Folds MUST be
 * one-at-a-time: two concurrent `git merge --ff-only` / `git cherry-pick` invocations onto the
 * same branch would corrupt each other's merge state. The single held sprint lock already
 * serialises the WHOLE parallel run against OTHER processes, but within ONE run the per-task
 * branches race each other — this queue is the in-process gate.
 *
 * `run(fn)` returns a promise that resolves with `fn`'s value once every previously-queued fold
 * has settled. Tasks fold in `base.tasks` order because the launcher enqueues them in that order
 * (each wave's branches are declared in task order, and a branch only reaches its fold step after
 * its own subchain settled — but the queue's FIFO ordering is what guarantees serialization, not
 * ordering across waves, which the scheduler already enforces).
 *
 * @public
 */
export interface FoldQueue {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Build a fresh fold queue. Each `run(fn)` chains onto the prior call's settle promise, so the
 * critical sections never overlap regardless of how many branches call concurrently. A rejecting
 * `fn` does not poison the queue — the tail advances on settle (ok or throw) so a conflicted fold
 * doesn't wedge the siblings behind it.
 *
 * @public
 */
export const createFoldQueue = (): FoldQueue => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      // Advance the tail on settle (success OR failure) so a rejected fold doesn't block the queue.
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
};

/**
 * Wrap an {@link AppendFile} so concurrent calls serialise through one in-process mutex. The
 * parallel path runs N branches at once, and several of them append to the SAME shared
 * `<memoryRoot>/<projectId>/learnings.ndjson` learning ledger (and, via
 * `append-journal-separator-leaf`, the prologue/epilogue's `<sprintDir>/progress.md` separator
 * lines). Two overlapping `fs.appendFile` calls to one file can interleave their writes and tear an
 * NDJSON line; the read side (ledger dedup) tolerates duplicate lines but NOT torn ones. Funnelling
 * every append through one {@link FoldQueue} makes each line atomic with respect to the others —
 * cheap (a promise chain), and it also yields a deterministic FIFO append order.
 *
 * Still load-bearing AFTER the ledger mutex landed: the prologue/epilogue's `progress.md`
 * separator appends do NOT go through `ImplementDeps.ledgerMutex`, so this wrapper is what keeps
 * those lines from tearing.
 *
 * The two WHOLE-FILE read-modify-writes are SEPARATE concerns and are NOT covered by this append
 * port: `progress-journal-<taskId>`'s per-attempt SECTION write (guarded by `journalMutex`) and
 * `append-learnings-<taskId>`'s ledger size-bounding (guarded by `ledgerMutex`, which also spans
 * that leaf's appends so a sibling append cannot land mid-rewrite). See `ProgressJournalLeafDeps`
 * / `AppendLearningsLeafDeps` / `ImplementDeps`. Per-task artefacts (`prompt.md`, `signals.json`)
 * are written to task-scoped paths and never collide, so only these shared files need
 * serialisation.
 *
 * @public
 */
export const serializeAppendFile = (inner: AppendFile): AppendFile => {
  const queue = createFoldQueue();
  return (path, text) => queue.run(() => inner(path, text));
};

/**
 * Per-branch signal publisher keyed on the branch's `taskId`. Replaces the launcher's old
 * single-slot `currentTaskId` tracker — which keyed off the dead `task-attempt-started` event
 * (zero production publishers) and so always attributed signals to `undefined`. With concurrent
 * branches a single shared mutable slot would cross-attribute signals anyway; binding the taskId
 * at branch-build time is the only correct model.
 *
 * Publishes EVERY validated signal kind (not just `<change>` / `<learning>` / `<note>` — that
 * filter only ever existed because the bus event was a secondary mirror of the app-wide sink; on
 * the single `ai-signal` channel every kind must flow or the TUI goes blind to
 * evaluation/decision/commit signals for parallel-branch tasks) onto the `ai-signal` EventBus
 * event, stamped with THIS branch's taskId so the per-task TUI panel groups it under the right
 * task.
 *
 * @public
 */
export const perBranchSignalPublisher = (eventBus: EventBus, taskId: TaskId): PublishSignal =>
  createPublishSignal(eventBus, 'implement', String(taskId));

/** Inputs the launcher derives once and shares across every branch of every wave. */
export interface BuildWaveBranchesDeps {
  readonly implement: ImplementDeps;
  readonly eventBus: EventBus;
  /** Shared fold mutex — every branch's fold step serialises through this one queue. */
  readonly foldQueue: FoldQueue;
}

/**
 * One git worktree per task: setup → per-worktree setup script → forked per-task subchain → fold →
 * quarantine-if-blocked → cleanup. The element is a hand-written {@link Element} (NOT a chain
 * primitive — §14) rather than a plain `sequential`, because worktree-cleanup MUST run on EVERY exit
 * path including abort: a plain `sequential` skips downstream children once a child aborts, which
 * would strand the worktree. This adapter runs cleanup in a `finally`-style guarantee and forwards
 * the inner result (AbortError verbatim).
 *
 *  - setup: prune stale bookkeeping + drop any leaked ref (both defensive), then
 *    `git worktree add -b <ref> <path>` forked from the sprint branch tip.
 *  - setup script: run the repo's `setupScript` IN the worktree (a fresh checkout has no build
 *    deps). Failure blocks ONLY this task; it never hard-aborts the wave. Skipped when the repo
 *    configures no setup script.
 *  - body: the forked per-task subchain (rooted on the worktree via `forkCtx`, branch-preflight
 *    omitted) followed by the serialised fold. `buildBody` (see `buildWorktreeBranch`) is a
 *    FACTORY, not a built element: it receives an `onSettled` callback that its subchain invokes
 *    with its OWN settled ctx right after the subchain returns — BEFORE the fold step runs. That
 *    side channel is what lets the quarantine step below still see a task that settled `blocked`
 *    even when the branch's OVERALL result ends up `Result.error` (`ElementResult`'s error arm
 *    carries no ctx at all) — e.g. a real user abort (or a fatal-sibling kill) landing in the short
 *    tail between the subchain settling the block and the fold step's own abort check.
 *  - quarantine (before cleanup — the fix for the parallel path's data-loss bug): whenever the
 *    settled ctx (the body's own result on success, or the `onSettled` side-channel ctx when the
 *    body itself errored) shows the task ended `blocked` with a rejected AI diff (`isSettledBlocked`
 *    — same gate the serial path's guard uses), stash it under the deterministic message BEFORE the
 *    worktree is destroyed. Runs regardless of `signal.aborted`: it is pure local git work with no
 *    signal-aware waiting of its own (see `runQuarantineBlockedDiff`'s docstring), so skipping it on
 *    an abort would destroy an already-settled, already-persisted block's diff for no reason — and
 *    `result` itself is untouched by this step, so an in-flight `AbortError` keeps propagating
 *    verbatim once this best-effort side effect returns.
 *    Run with `cwd` = the WORKTREE (that's where the uncommitted diff physically sits) — worktrees
 *    share `.git` with the main repo, so the resulting stash survives `git worktree remove --force`
 *    (verified with a throwaway repo: create a worktree, dirty it, `git stash push` from inside it,
 *    `git worktree remove --force`, then `git stash list` / `git stash pop` from the main repo — the
 *    entry and its content both survive). Best-effort: a quarantine failure is logged at `warn` and
 *    never fails the branch — see `quarantine-blocked-diff.ts`'s `runQuarantineBlockedDiff`.
 *  - cleanup: `git worktree remove --force` always; `git branch -D <ref>` UNLESS the task ended
 *    `blocked` — a fold conflict blocks a task whose commits are already verified and landed on
 *    THIS ref and nowhere else, so deleting it here would strand that work in the reflog until GC.
 *    `setupWorktree`'s defensive `gitDeleteBranch` already tolerates (and drops) a leftover ref on
 *    relaunch, so keeping it is cheap.
 */
const withWorktree = (
  deps: BuildWaveBranchesDeps,
  repoRoot: AbsolutePath,
  worktreePath: AbsolutePath,
  branchRef: string,
  taskId: TaskId,
  setupScript: string | undefined,
  progressFile: AbsolutePath,
  buildBody: (onSettled: (ctx: ImplementCtx) => void) => Element<ImplementCtx>
): Element<ImplementCtx> => {
  // Built once, with a no-op callback, purely to expose the body's shape for the TUI's upfront
  // plan (`children` — see `Element`'s docstring: it lets a caller walk the tree without executing
  // it). The real run below builds its OWN body per execution so each call gets an independent
  // `settledCtx` side-channel — `buildBody` is deterministic given the same closed-over params, so
  // the two builds share the same `name` / `children` shape.
  const bodyShape = buildBody(() => {});
  return {
    name: `worktree(${String(taskId)})`,
    children: [bodyShape],
    async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
      const gitRunner = deps.implement.gitRunner;
      const setupError = await setupWorktree(gitRunner, repoRoot, worktreePath, branchRef, taskId, onTrace);
      if (setupError !== undefined) {
        // A worktree that never got created has nothing to clean up — return the setup failure as-is
        // (non-fatal → the wave reducer leaves this task untouched so it resets/re-runs).
        return setupError;
      }

      // See the docstring above: the body's subchain stamps this right after it settles, before
      // the fold step runs, so it survives even when the branch's overall result later errors.
      let settledCtx: ImplementCtx | undefined;
      const body = buildBody((bodyCtx) => {
        settledCtx = bodyCtx;
      });

      // Definite-assignment: every path through the `try` below assigns `result` before falling out
      // of it — a throw instead propagates past the whole function (never reaching `return result`).
      let result!: ElementResult<ImplementCtx>;
      try {
        // Per-worktree setup runs INSIDE the freshly-created worktree, before the task's subchain.
        // A git worktree is an empty checkout with no build artefacts, so the per-task verifyScript
        // would fail spuriously without it. `undefined` (block this task) short-circuits the body;
        // cleanup below still runs.
        const setupBlocked = await runWorktreeSetupScript(
          deps,
          worktreePath,
          setupScript,
          taskId,
          ctx,
          signal,
          onTrace
        );
        result = setupBlocked ?? (await body.execute(ctx, signal, onTrace));
      } finally {
        // Prefer the body's own returned ctx when the branch completed; fall back to the
        // side-channel ctx (captured BEFORE the fold step ran) when the overall result is an error
        // — a fold conflict resolves to `Result.ok` on its own, so the only errors reaching here
        // with a genuinely-settled block are aborts, whose `Result.error` arm carries no ctx.
        const effectiveCtx = result.ok ? result.value.ctx : settledCtx;
        const blockedTask = effectiveCtx !== undefined ? findBlockedTask(effectiveCtx, taskId) : undefined;
        if (blockedTask !== undefined && effectiveCtx !== undefined && isSettledBlocked(effectiveCtx, taskId)) {
          const name = `quarantine-blocked-diff-${String(taskId)}`;
          const start = performance.now();
          const outcome = await runQuarantineBlockedDiff(
            {
              gitRunner: deps.implement.gitRunner,
              taskRepo: deps.implement.taskRepo,
              appendFile: deps.implement.appendFile,
              logger: deps.implement.logger,
            },
            { cwd: worktreePath, progressFile },
            { task: blockedTask, sprintId: effectiveCtx.sprintId },
            taskId
          );
          onTrace?.({ elementName: name, status: 'completed', durationMs: performance.now() - start });
          // Fold the updated `blockedReason` (the recovery pointer, on a real capture — `runQuarantine-
          // BlockedDiff` never errors, see its docstring) back into the returned ctx so the wave merge
          // / epilogue save persists the SAME pointer `recordQuarantineUseCase` already wrote to disk —
          // otherwise the epilogue's later `tasks.json` write would clobber it. Only meaningful when
          // `result.ok`: an errored/aborted result has no ctx slot to fold into, and
          // `recordQuarantineUseCase` already persisted the pointer straight to `taskRepo` regardless
          // — the abort path loses nothing by skipping this fold-back.
          if (result.ok && outcome.ok && outcome.value !== undefined) {
            const tasks = (result.value.ctx.tasks ?? []).map((t) => (t.id === outcome.value?.id ? outcome.value : t));
            result = Result.ok({ ctx: { ...result.value.ctx, tasks }, trace: result.value.trace });
          }
        }
        // Cleanup ALWAYS runs — success, non-fatal failure, or abort. The worktree's commits are
        // already folded by the body's fold step (or this ref is the only place they live, if the
        // fold itself is what blocked the task), so a forced remove only ever drops scratch state.
        await cleanupWorktree(
          gitRunner,
          repoRoot,
          worktreePath,
          branchRef,
          taskId,
          onTrace,
          deps.implement,
          blockedTask !== undefined
        );
      }
      return result;
    },
  };
};

/** `taskId`'s copy off a ctx, if it's there AND ended `blocked`. */
const findBlockedTask = (ctx: ImplementCtx, taskId: TaskId): BlockedTask | undefined => {
  const task = ctx.tasks?.find((t) => t.id === taskId);
  return task?.status === 'blocked' ? task : undefined;
};

/**
 * Run the repo's `setupScript` inside the freshly-created worktree, before the per-task subchain.
 * A git worktree is a bare checkout: `node_modules`, `target/`, `.venv`, build caches — none of it
 * is present (those paths are git-ignored and not copied). The per-task `verifyScript` runs pre-
 * AND post-task in THIS worktree, so without a per-worktree setup it would fail as
 * `baseline-broken` / `regressed` and block legitimate work. The prologue's once-per-repo setup
 * preps the MAIN repo, not these throwaway worktrees, so it cannot cover this.
 *
 * Returns `undefined` when there is no setup script or it succeeds (the caller proceeds to the
 * body). On failure (non-zero exit, timeout, or spawn error) it BLOCKS only this task and returns a
 * narrowed `Result.ok` carrying the blocked task — siblings run in their own worktrees and are
 * untouched, and the wave is NEVER hard-aborted (unlike the prologue's main-repo setup gate, whose
 * hard-abort semantics are wrong for one isolated worktree). A user abort that races the setup
 * propagates verbatim, never a block.
 */
const runWorktreeSetupScript = async (
  deps: BuildWaveBranchesDeps,
  worktreePath: AbsolutePath,
  setupScript: string | undefined,
  taskId: TaskId,
  ctx: ImplementCtx,
  signal: AbortSignal | undefined,
  onTrace: OnTrace | undefined
): Promise<ElementResult<ImplementCtx> | undefined> => {
  if (setupScript === undefined || setupScript.trim() === '') return undefined;
  const name = `worktree-setup-script-${String(taskId)}`;
  // Don't burn an install while the user is already aborting.
  if (signal?.aborted) return abortedStep(name, 0, onTrace);

  const start = performance.now();
  // Thread the chain abort signal into the runner so a Ctrl-C mid-setup kills the child promptly
  // instead of waiting out the shell timeout while the wave holds its worktree.
  const ran = await deps.implement.shellScriptRunner.run(
    worktreePath,
    setupScript,
    signal !== undefined ? { signal } : {}
  );
  const durationMs = performance.now() - start;

  if (ran.ok && ran.value.passed) {
    onTrace?.({ elementName: name, status: 'completed', durationMs });
    return undefined;
  }
  // A user abort surfaces as the runner's AbortError (signal threaded above) — and may also race
  // the setup's natural failure — so re-check the signal before treating it as a real failure.
  if (signal?.aborted) return abortedStep(name, durationMs, onTrace);

  const detail = ran.ok ? `exit ${String(ran.value.exitCode ?? 'null')}` : ran.error.message;
  const reason = `worktree setup script failed (${detail}) — the task could not be prepared in its isolated worktree`;
  return blockTaskInWorktree(deps, ctx, taskId, name, durationMs, reason, onTrace);
};

/**
 * Block THIS task after a per-worktree setup failure and narrow the ctx to it. Setup runs before
 * the subchain, so the task is still `todo`/`in_progress` — `markTaskBlocked` (which accepts only
 * those states) is the clean domain transition (no hand-projection like `worktree-fold.ts`'s
 * `blockTaskForFoldConflict`, which exists only because a fold conflict re-blocks an already-`done`
 * task). Returns `Result.ok`
 * so the branch runner COMPLETES with the block in its ctx — `mergeImplementWave` overlays it and
 * `captureDurableFold` records it, so the block survives even an abort of a sibling wave.
 */
const blockTaskInWorktree = (
  deps: BuildWaveBranchesDeps,
  ctx: ImplementCtx,
  taskId: TaskId,
  name: string,
  durationMs: number,
  reason: string,
  onTrace: OnTrace | undefined
): ElementResult<ImplementCtx> => {
  deps.implement.logger.warn('worktree setup script failed — task blocked', { taskId: String(taskId), reason });
  const entry: TraceEntry = { elementName: name, status: 'failed', durationMs };
  onTrace?.(entry);
  const task = ctx.tasks?.find((t) => t.id === taskId);
  // No task in ctx (shouldn't happen — the wave carries the full list), or the task isn't in a
  // blockable state: carry ctx through so the reducer leaves base untouched and it resets/re-runs.
  if (task === undefined) return Result.ok({ ctx, trace: [entry] });
  // Per-worktree setup failure is an own-failure block — the task couldn't be prepared, which a
  // relaunch / operator fix must address; it never cascade-clears via upstream unblock. Classified
  // explicitly: the repo/runtime state in the fresh worktree is what needs fixing, not the model.
  const blocked = markTaskBlocked(task, reason, 'own', {
    blockCause: 'worktree-setup-failure',
    faultSide: 'environment',
  });
  if (!blocked.ok) return Result.ok({ ctx, trace: [entry] });
  // Narrow to THIS task only — the merge overlay is by-id; emitting siblings risks clobbering a
  // concurrently-merged copy (the same narrowing contract the branch body applies after its subchain).
  return Result.ok({ ctx: { ...ctx, tasks: [blocked.value] }, trace: [entry] });
};

/**
 * Create the worktree. Returns `undefined` on success (the subchain advances ctx), or a failed
 * {@link ElementResult} on `worktree add` failure so the branch fails without ever materialising a
 * worktree to clean up.
 */
const setupWorktree = async (
  gitRunner: GitRunner,
  repoRoot: AbsolutePath,
  worktreePath: AbsolutePath,
  branchRef: string,
  taskId: TaskId,
  onTrace: ((entry: TraceEntry) => void) | undefined
): Promise<ElementResult<ImplementCtx> | undefined> => {
  const name = `worktree-setup-${String(taskId)}`;
  const start = performance.now();
  // Prune defensively first: a crashed prior run can leave a stale `.git/worktrees/<name>` record
  // whose directory has vanished, which would make `worktree add` fail. Prune is idempotent.
  await gitWorktreePrune(gitRunner, repoRoot);
  // Defensively drop a LEAKED `wt-<task>` ref before re-adding. `cleanupWorktree` deletes the ref
  // after `worktree remove`, but a process that crashed between those two steps (or a delete that
  // failed) leaves the ref behind — and `git worktree add -b <same-ref>` then fails loudly with
  // 'branch already exists'. Prune only reaps `.git/worktrees/<name>` records for missing dirs, not
  // orphaned refs, so it cannot heal this on its own. Best-effort: a live ref (no leak) just isn't
  // there to delete, and a ref checked out elsewhere refuses deletion — in which case the `add`
  // below fails loudly, which is the correct signal that something genuinely conflicts.
  await gitDeleteBranch(gitRunner, repoRoot, branchRef);
  const added = await gitWorktreeAdd(gitRunner, repoRoot, worktreePath, branchRef);
  const durationMs = performance.now() - start;
  if (!added.ok) {
    const entry: TraceEntry = { elementName: name, status: 'failed', durationMs, error: added.error };
    onTrace?.(entry);
    return Result.error({ error: added.error, trace: [entry] });
  }
  onTrace?.({ elementName: name, status: 'completed', durationMs });
  return undefined;
};

const cleanupWorktree = async (
  gitRunner: GitRunner,
  repoRoot: AbsolutePath,
  worktreePath: AbsolutePath,
  branchRef: string,
  taskId: TaskId,
  onTrace: ((entry: TraceEntry) => void) | undefined,
  deps: ImplementDeps,
  taskEndedBlocked: boolean
): Promise<void> => {
  const name = `worktree-cleanup-${String(taskId)}`;
  const start = performance.now();
  const removed = await gitWorktreeRemove(gitRunner, repoRoot, worktreePath);
  const durationMs = performance.now() - start;
  if (!removed.ok) {
    // Best-effort: a left-over worktree is scratch (commits already folded). Surface as a warn so
    // the operator can prune it manually, but never fail the branch over teardown.
    deps.logger.warn('worktree cleanup failed', {
      taskId: String(taskId),
      worktreePath: String(worktreePath),
      error: removed.error.message,
    });
    onTrace?.({ elementName: name, status: 'failed', durationMs, error: removed.error });
    return;
  }
  if (taskEndedBlocked) {
    // Keep the branch ref alive when the task ended blocked: a fold-conflict block re-projects an
    // already-`done` task back to `blocked` AFTER its commits landed on THIS ref — deleting it here
    // would leave that verified, committed work reachable only via reflog until GC (the
    // blockedReason literally names this ref). An own-failure block (setup script / attempt-loop
    // self-block) may have nothing of value on the ref, but keeping it uniformly is cheap:
    // `setupWorktree`'s defensive `gitDeleteBranch` already tolerates and drops a leftover ref on
    // relaunch, so the only cost is a greppable ref surviving until then.
    deps.logger.warn('worktree branch kept — task ended blocked', { taskId: String(taskId), branchRef });
    onTrace?.({ elementName: name, status: 'completed', durationMs });
    return;
  }
  // `worktree remove` leaves the throwaway `wt-<task>` branch ref behind; drop it so a relaunch
  // can recreate the worktree with `add -b <same-ref>`. Best-effort — a surviving ref is harmless
  // scratch (the commit is already folded), so a delete failure is logged, never fatal.
  const branchDeleted = await gitDeleteBranch(gitRunner, repoRoot, branchRef);
  if (!branchDeleted.ok) {
    deps.logger.warn('worktree branch cleanup failed', {
      taskId: String(taskId),
      branchRef,
      error: branchDeleted.error.message,
    });
  }
  onTrace?.({ elementName: name, status: 'completed', durationMs });
};

/**
 * Build the per-wave `WaveBranch[]` arrays for the parallel implement path.
 *
 * One {@link WaveBranch} per task: its element is the worktree adapter wrapping the forked
 * per-task subchain followed by the serialised fold. `forkCtx` clears per-task ctx and points the
 * `RepoExecConfig` at the task's worktree; the subchain is built with `branch-preflight` OMITTED
 * (each worktree is checked out on its own ref). A per-branch {@link PublishSignal} (see
 * {@link perBranchSignalPublisher}) keyed on the branch's `taskId` is injected so concurrent
 * branches' signals attribute correctly.
 *
 * Each branch runs on its own runner (provided by `runWaves`) whose `initialCtx` is the wave's
 * carried base ctx. The branch element forks that carried ctx onto the worktree at EXECUTE time
 * (via `forkCtx`) so it always sees the most recently merged sprint / tasks state.
 *
 * @public
 */
export const buildWaveBranches = (
  deps: BuildWaveBranchesDeps,
  opts: CreateImplementFlowOpts,
  waves: ReadonlyArray<readonly Task[]>,
  readConfig: PerTaskReadConfig
): ReadonlyArray<ReadonlyArray<WaveBranch<ImplementCtx>>> =>
  waves.map((wave) => wave.map((task) => buildOneBranch(deps, opts, task, readConfig)));

type PerTaskReadConfig = () => Promise<{
  readonly maxTurns: number;
  readonly escalateOnPlateau: boolean;
  readonly escalationMap: Readonly<Record<string, string>>;
  readonly maxAttempts: number;
}>;

const buildOneBranch = (
  deps: BuildWaveBranchesDeps,
  opts: CreateImplementFlowOpts,
  task: Task,
  readConfig: PerTaskReadConfig
): WaveBranch<ImplementCtx> => {
  const repo = resolveRepoOrThrow(opts.repositories, task);
  const worktreePath = worktreePathFor(opts.sprintDir, task.id);
  const branchRef = gitWorktreeRef(String(opts.sprintId), String(task.id));

  // Per-branch deps clone — only the signal publisher differs (keyed on this task's id so
  // concurrent branches don't cross-attribute their signals). Everything else, including the
  // run's shared `journalMutex` / `ledgerMutex`, is inherited from `deps.implement`.
  const branchDeps: ImplementDeps = {
    ...deps.implement,
    publishSignal: perBranchSignalPublisher(deps.eventBus, task.id),
  };

  const subchainOpts: PerTaskSubchainOpts = {
    sprintDir: opts.sprintDir,
    progressFile: opts.progressFile,
    terminalLeafName: 'uninstall-skills',
    generator: {
      providerId: opts.generatorProviderId,
      model: opts.generatorModel,
      ...(opts.generatorEffort !== undefined ? { effort: opts.generatorEffort } : {}),
      ...(opts.generatorAgentDefinitionSection !== undefined
        ? { agentDefinitionSection: opts.generatorAgentDefinitionSection }
        : {}),
    },
    evaluator: {
      providerId: opts.evaluatorProviderId,
      model: opts.evaluatorModel,
      ...(opts.evaluatorEffort !== undefined ? { effort: opts.evaluatorEffort } : {}),
      ...(opts.evaluatorAgentDefinitionSection !== undefined
        ? { agentDefinitionSection: opts.evaluatorAgentDefinitionSection }
        : {}),
    },
    memoryRoot: opts.memoryRoot,
    projectId: opts.projectId,
    projectSlug: opts.projectSlug,
    includeBranchPreflight: false,
    ...(opts.generatorAgentDefinition !== undefined ? { generatorAgentDefinition: opts.generatorAgentDefinition } : {}),
    ...(opts.evaluatorAgentDefinition !== undefined ? { evaluatorAgentDefinition: opts.evaluatorAgentDefinition } : {}),
  };

  // The per-task subchain is built fresh on the FORKED ctx + worktree repo each time the branch
  // executes (so a re-merged wave ctx flows in). `buildSubchain` captures everything needed.
  const buildSubchain = (worktreeRepo: RepoExecConfig): Element<ImplementCtx> =>
    createPerTaskSubchain(branchDeps, subchainOpts, task, worktreeRepo, readConfig);

  return {
    id: `task-${String(task.id)}`,
    element: buildWorktreeBranch(deps, repo, task, worktreePath, branchRef, opts.progressFile, buildSubchain),
  };
};

/**
 * Assemble the worktree-wrapped branch element from a subchain FACTORY. The factory receives the
 * worktree-pointed {@link RepoExecConfig} and returns the per-task body element to run inside the
 * worktree. Exposed (not inlined) so tests can substitute a fake subchain — the worktree
 * setup/fold/cleanup + ctx-fork wiring is exercised independently of the real per-task chain.
 *
 * `progressFile` is threaded as an explicit PARAMETER (not read off ctx) because it must be
 * available to the worktree teardown's quarantine step even when the branch's overall result is an
 * error (a fold conflict's own abort check, or a real abort) — `ImplementCtx.progressFile` is
 * sprint-scoped and always populated by the caller here, but `ElementResult`'s error arm carries no
 * ctx at all, so reading it off a possibly-errored result would make quarantine silently inert on
 * every path that needs it most. `opts.progressFile` is already in scope at the call site
 * (`buildOneBranch`) — see that function.
 *
 * `forkCtx` produces the worktree-pointed ctx + repo at EXECUTE time (so a re-merged wave ctx flows
 * in); the worktree adapter runs setup, then the body (`subchain → fold`), then cleanup-on-every-
 * path (including abort).
 *
 * @public
 */
export const buildWorktreeBranch = (
  deps: BuildWaveBranchesDeps,
  repo: RepoExecConfig,
  task: Task,
  worktreePath: AbsolutePath,
  branchRef: string,
  progressFile: AbsolutePath,
  buildSubchain: (worktreeRepo: RepoExecConfig) => Element<ImplementCtx>
): Element<ImplementCtx> => {
  // A FACTORY, not a built element: `withWorktree` calls this once per execution so each run gets
  // its own `onSettled` side-channel. `onSettled` fires with the subchain's OWN settled ctx right
  // AFTER the subchain returns but BEFORE the fold step runs — see `withWorktree`'s docstring for
  // why the teardown needs this rather than reading the branch's overall (possibly-errored) result.
  const buildBody = (onSettled: (ctx: ImplementCtx) => void): Element<ImplementCtx> => ({
    name: `task-${String(task.id)}-branch-body`,
    children: [],
    async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
      // Fork the carried base ctx onto the worktree at EXECUTE time, so the branch sees the most
      // recent merged ctx (sprint/tasks). `forkCtx` clears per-task state + drops the
      // verify-baseline; the returned repo points at the worktree.
      const { ctx: forkedCtx, repo: worktreeRepo } = forkCtx(ctx, repo, worktreePath);
      const subchain = buildSubchain(worktreeRepo);
      const subchainResult = await subchain.execute(forkedCtx, signal, onTrace);
      if (!subchainResult.ok) return subchainResult;
      onSettled(subchainResult.value.ctx);
      const fold = foldStep(deps, repo.path, branchRef, task.id);
      const foldResult = await fold.execute(subchainResult.value.ctx, signal, onTrace);
      if (!foldResult.ok) return foldResult;
      // Narrow this branch's outcome ctx to carry ONLY its OWN task. `forkCtx` seeds `tasks` with the
      // full base list (so the subchain leaves can look up sibling deps), but the subchain only
      // settles THIS task; the others remain at their pre-wave status. `mergeImplementWave` overlays
      // EVERY task in each branch's outcome ctx onto `base.tasks` by id — so leaving the siblings in
      // would let a later-processed branch overwrite an earlier branch's settled task with a stale
      // copy. Emitting only the owned task makes the overlay disjoint + commutative (the wave-merge contract).
      const own = foldResult.value.ctx.tasks?.find((t) => t.id === task.id);
      const narrowed: ImplementCtx = { ...foldResult.value.ctx, ...(own !== undefined ? { tasks: [own] } : {}) };
      return Result.ok({
        ctx: narrowed,
        trace: [...subchainResult.value.trace, ...foldResult.value.trace],
      });
    },
  });
  return withWorktree(deps, repo.path, worktreePath, branchRef, task.id, repo.setupScript, progressFile, buildBody);
};

/**
 * Per-task worktree directory: `<sprintDir>/worktrees/wt-<taskId>`. Sprint-scoped + cleaned up per
 * task, so worktrees never leak into the user's repo tree and prune cleanly with the sprint dir.
 * @public
 */
export const worktreePathFor = (sprintDir: AbsolutePath, taskId: TaskId): AbsolutePath => {
  const path = AbsolutePath.parse(join(String(sprintDir), 'worktrees', `wt-${String(taskId)}`));
  // `sprintDir` is already a validated absolute path and the suffix is path-safe (UUID-shaped
  // taskId), so this parse cannot fail in practice — throw on the programmer-error path if it does.
  if (!path.ok) throw path.error;
  return path.value;
};
