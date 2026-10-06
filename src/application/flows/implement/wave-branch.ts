import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { join } from 'node:path';

import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { WaveBranch } from '@src/application/chain/run/wave-scheduler.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { DirtyTreePolicy } from '@src/business/task/preflight-task.ts';
import { createPublishSignal, type PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import { gitWorktreeRef } from '@src/integration/io/git-operations.ts';

import type { AppendFile } from '@src/business/io/append-file.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import {
  type CreateImplementFlowOpts,
  effectiveDirtyTreePolicy,
  perTaskSubchainOpts,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';
import { forkCtx, implementBranchId } from '@src/application/flows/implement/merge-wave.ts';
import { resolveRepoOrThrow } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import {
  createPerTaskSubchain,
  type PerTaskSubchainOpts,
} from '@src/application/flows/implement/leaves/per-task-subchain.ts';
import type { AttemptReadConfig } from '@src/application/flows/implement/leaves/attempt-body.ts';
import { foldStep } from '@src/application/flows/implement/worktree-fold.ts';
import {
  foldQuarantinePointer,
  snapshotQuarantinedDiff,
  teardownWorktree,
  type WorktreeTeardownArgs,
} from '@src/application/flows/implement/worktree-teardown.ts';
import {
  runWorktreeSetupScript,
  setupWorktree,
  type WorktreeSetupSpec,
} from '@src/application/flows/implement/worktree-setup.ts';

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
 * One git worktree per task: start snapshot → setup → per-worktree setup script → forked per-task
 * subchain → fold → quarantine-if-blocked → re-stash-if-interrupted → cleanup. The element is a
 * hand-written {@link Element} (NOT a chain primitive — §14) rather than a plain `sequential`,
 * because worktree-cleanup MUST run on EVERY exit path including abort: a plain `sequential` skips
 * downstream children once a child aborts, which would strand the worktree. This adapter runs the
 * teardown on every exit path — settled result, abort, AND a throw out of the body — and forwards
 * the inner result (AbortError verbatim).
 *
 *  - start snapshot: how many entries this task's quarantine key holds in the stash, read before
 *    anything in the branch can pop one — and before the worktree exists, so a raw throw out of it
 *    has nothing to strand. The teardown needs it to tell a restored diff an interrupted attempt left
 *    in the worktree from work that never sat in any stash — see `snapshotQuarantinedDiff`.
 *  - setup: prune stale bookkeeping + clear any ref an earlier run left (current or legacy shape:
 *    deleted when the sprint branch has its commits, else moved under `ralphctl-rescue/`), then
 *    `git worktree add -b <ref> <path>` forked from the sprint branch tip.
 *  - setup script: run the repo's `setupScript` IN the worktree (a fresh checkout has no build
 *    deps), bracketed by a working-tree check that settles whatever the script changed against
 *    the main checkout's recorded answer (`worktree-setup-tree.ts`). A failure, or a change the
 *    check refuses, blocks ONLY this task; it never hard-aborts the wave. Skipped when the repo
 *    configures no setup script.
 *  - body: the forked per-task subchain (rooted on the worktree via `forkCtx`, branch-preflight
 *    omitted) followed by the serialised fold. `buildBody` (see `buildWorktreeBranch`) is a
 *    FACTORY, not a built element: it receives an `onSettled` callback that its subchain invokes
 *    with its OWN settled ctx right after the subchain returns — BEFORE the fold step runs. That
 *    side channel is what lets the quarantine step below still see a task that settled `blocked`
 *    even when the branch's OVERALL result ends up `Result.error` (`ElementResult`'s error arm
 *    carries no ctx at all) — e.g. a real user abort (or a fatal-sibling kill) landing in the short
 *    tail between the subchain settling the block and the fold step's own abort check.
 *  - quarantine (before cleanup — the fix for the parallel path's data-loss bug): whenever the task
 *    ended `blocked` with a rejected AI diff, stash it under the deterministic message BEFORE the
 *    worktree is destroyed, even on an abort. How the task ended comes from the body's own result on
 *    success, the `onSettled` side-channel ctx when the body errored after the subchain returned,
 *    and the PERSISTED task when the subchain itself errored (an abort landing in a leaf after
 *    `settle-attempt` already persisted `blocked`) — when that read fails and the worktree may hold
 *    work, the worktree is left on disk instead. See `worktree-teardown.ts`.
 *  - re-stash (before cleanup): a branch interrupted mid-attempt (abort, error, throw) whose task key
 *    now holds fewer stash entries than at branch start, and whose last attempt committed nothing,
 *    pushes the worktree's changes back under the same message — `restore-blocked-diff` popped that
 *    diff, and the pop dropped the only other copy. When that can't be confirmed, the worktree is
 *    left on disk instead. See `requarantineRestoredDiff` in `worktree-teardown.ts`.
 *  - cleanup: `git worktree remove --force`; `git branch -D <ref>` UNLESS the task ended
 *    `blocked` or the branch never completed its fold (see `keepBranchRefReason` in
 *    `worktree-teardown.ts`) — a fold conflict blocks a task whose commits are already verified and
 *    landed on THIS ref and nowhere else, and an abort or a throw landing between the subchain
 *    settling `done` and the fold step leaves those commits equally ref-only, so deleting it here
 *    would strand that work in the reflog until GC. On that task's next launch `setupWorktree`
 *    deletes the kept ref only if the sprint branch has its commits; otherwise it moves it aside.
 *  - a THROW out of the body (`leaf.ts` re-throws every non-DomainError verbatim, and
 *    `buildSubchain` itself runs inside the body) takes the SAME teardown and then re-propagates
 *    the original error untouched — see the `catch` arm below.
 */
const withWorktree = (
  deps: BuildWaveBranchesDeps,
  repoRoot: AbsolutePath,
  worktreePath: AbsolutePath,
  branchRef: string,
  taskId: TaskId,
  setup: WorktreeSetupSpec | undefined,
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
    async execute(ctx, signal, onTrace, onStart): Promise<ElementResult<ImplementCtx>> {
      const quarantinedAtStart = await snapshotQuarantinedDiff(deps, repoRoot, ctx.sprintId, taskId);
      const target = { repoRoot, worktreePath, branchRef, taskId, progressFile };
      const setupError = await setupWorktree(deps, ctx, target, onTrace, onStart);
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
      const teardownArgs: WorktreeTeardownArgs = {
        deps,
        repoRoot,
        worktreePath,
        branchRef,
        taskId,
        sprintId: ctx.sprintId,
        attemptsAtStart: ctx.tasks?.find((t) => t.id === taskId)?.attempts.length ?? 0,
        quarantinedAtStart,
        progressFile,
        onTrace,
      };

      // The try covers ONLY the work that can throw — the settled-path teardown is hoisted out
      // below it deliberately. Inside, a teardown that threw on its own (a raw error out of
      // `onTrace` / `taskRepo` / `appendFile`, the same class the throw arm exists for) would be
      // caught by that arm and run a SECOND time, with `result` lost: a second `git stash push` on
      // a now-clean tree, a second `worktree remove` against a removed dir, and a
      // `keepBranchRefReason` flipped to `fold-incomplete` on a branch whose ref should have been
      // deleted. Every path out of the try either assigns `result` or throws, so the plain `let`
      // below is definitely assigned by the time the teardown reads it.
      let result: ElementResult<ImplementCtx>;
      try {
        // Per-worktree setup runs INSIDE the freshly-created worktree, before the task's subchain.
        // A git worktree is an empty checkout with no build artefacts, so the per-task verifyScript
        // would fail spuriously without it. `undefined` (block this task) short-circuits the body;
        // the teardown below still runs.
        const setupBlocked = await runWorktreeSetupScript(
          deps,
          worktreePath,
          setup,
          taskId,
          ctx,
          signal,
          onTrace,
          onStart
        );
        result = setupBlocked ?? (await body.execute(ctx, signal, onTrace, onStart));
      } catch (error) {
        // A THROW, not a `Result.error`: `leaf.ts` re-throws every non-DomainError verbatim and
        // `buildSubchain` is constructed inside `body.execute`, so a projection bug — or any raw
        // TypeError out of an adapter — arrives here with no result at all. Tear the worktree down
        // exactly as the settled paths do (skipping it would strand `wt-<task>` and its ref, and
        // every later launch of this task would then fail in `git worktree add`), then re-throw the
        // ORIGINAL error untouched. Nothing here inspects or converts it, so an `AbortError`
        // travelling this path propagates verbatim too.
        await teardownWorktree(teardownArgs, undefined, settledCtx);
        throw error;
      }
      // Settled path — outside the try so a throwing teardown propagates instead of re-entering
      // itself through the catch arm above.
      return foldQuarantinePointer(result, await teardownWorktree(teardownArgs, result, settledCtx));
    },
  };
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
  readConfig: AttemptReadConfig
): ReadonlyArray<ReadonlyArray<WaveBranch<ImplementCtx>>> =>
  waves.map((wave) => wave.map((task) => buildOneBranch(deps, opts, task, readConfig)));

const buildOneBranch = (
  deps: BuildWaveBranchesDeps,
  opts: CreateImplementFlowOpts,
  task: Task,
  readConfig: AttemptReadConfig
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

  const subchainOpts: PerTaskSubchainOpts = { ...perTaskSubchainOpts(opts), includeBranchPreflight: false };

  // The per-task subchain is built fresh on the FORKED ctx + worktree repo each time the branch
  // executes (so a re-merged wave ctx flows in). `buildSubchain` captures everything needed.
  const buildSubchain = (worktreeRepo: RepoExecConfig): Element<ImplementCtx> =>
    createPerTaskSubchain(branchDeps, subchainOpts, task, worktreeRepo, readConfig);

  return {
    id: implementBranchId(task.id),
    element: buildWorktreeBranch(
      deps,
      repo,
      task,
      worktreePath,
      branchRef,
      opts.progressFile,
      buildSubchain,
      effectiveDirtyTreePolicy(opts)
    ),
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
 * `policy` is the run's dirty-tree policy, applied by the per-worktree setup check to a change the
 * main checkout's setup never showed (see `worktree-setup-tree.ts`); it defaults like the flow's.
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
  buildSubchain: (worktreeRepo: RepoExecConfig) => Element<ImplementCtx>,
  policy: DirtyTreePolicy = effectiveDirtyTreePolicy({})
): Element<ImplementCtx> => {
  // Display shape only, built on first read: each run builds its own subchain on the forked ctx.
  let shape: ReadonlyArray<Element<ImplementCtx>> | undefined;
  const bodyShape = (): ReadonlyArray<Element<ImplementCtx>> => {
    if (shape !== undefined) return shape;
    const subchain = buildSubchain({ ...repo, path: worktreePath });
    // The fold shows as the task's last step, inside its work item rather than beside it.
    const fold = foldStep(deps, repo.path, branchRef, task.id);
    shape = [{ ...subchain, children: [...(subchain.children ?? []), fold] }];
    return shape;
  };
  // A FACTORY, not a built element: `withWorktree` calls this once per execution so each run gets
  // its own `onSettled` side-channel. `onSettled` fires with the subchain's OWN settled ctx right
  // AFTER the subchain returns but BEFORE the fold step runs — see `withWorktree`'s docstring for
  // why the teardown needs this rather than reading the branch's overall (possibly-errored) result.
  const buildBody = (onSettled: (ctx: ImplementCtx) => void): Element<ImplementCtx> => ({
    name: `task-${String(task.id)}-branch-body`,
    get children() {
      return bodyShape();
    },
    async execute(ctx, signal, onTrace, onStart): Promise<ElementResult<ImplementCtx>> {
      // Fork the carried base ctx onto the worktree at EXECUTE time, so the branch sees the most
      // recent merged ctx (sprint/tasks). `forkCtx` clears per-task state + drops the
      // verify-baseline; the returned repo points at the worktree.
      const { ctx: forkedCtx, repo: worktreeRepo } = forkCtx(ctx, repo, worktreePath);
      const subchain = buildSubchain(worktreeRepo);
      const subchainResult = await subchain.execute(forkedCtx, signal, onTrace, onStart);
      if (!subchainResult.ok) return subchainResult;
      onSettled(subchainResult.value.ctx);
      const fold = foldStep(deps, repo.path, branchRef, task.id);
      const foldResult = await fold.execute(subchainResult.value.ctx, signal, onTrace, onStart);
      if (!foldResult.ok) return foldResult;
      // Narrow this branch's outcome ctx to carry ONLY its OWN task. `forkCtx` seeds `tasks` with the
      // full base list (so the subchain leaves can look up sibling deps), but the subchain only
      // settles THIS task; the others remain at their pre-wave status. Belt-and-braces: ownership is
      // now enforced by the merge itself (`mergeImplementWave` / `captureDurableFold` both read only
      // `ownedTask(branch.id, ctx)`), so a wider ctx here can no longer let a later-processed branch
      // overwrite an earlier branch's settled task — but narrowing at the source keeps that
      // guarantee structural in two places instead of relying on the reader alone.
      const own = foldResult.value.ctx.tasks?.find((t) => t.id === task.id);
      const narrowed: ImplementCtx = { ...foldResult.value.ctx, ...(own !== undefined ? { tasks: [own] } : {}) };
      return Result.ok({
        ctx: narrowed,
        trace: [...subchainResult.value.trace, ...foldResult.value.trace],
      });
    },
  });
  const script = repo.setupScript?.trim() ?? '';
  const setup = script.length > 0 ? { script, repositoryId: task.repositoryId, policy } : undefined;
  return withWorktree(deps, repo.path, worktreePath, branchRef, task.id, setup, progressFile, buildBody);
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
