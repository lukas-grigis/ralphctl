import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { join } from 'node:path';

import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { OnTrace, TraceEntry } from '@src/application/chain/trace.ts';
import type { WaveBranch } from '@src/application/chain/run/wave-scheduler.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { DirtyTreePolicy } from '@src/business/task/preflight-task.ts';
import { publishTaskBlocked } from '@src/business/task/publish-task-blocked.ts';
import { createPublishSignal, type PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import {
  gitDeleteBranch,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRef,
} from '@src/integration/io/git-operations.ts';

import type { AppendFile } from '@src/business/io/append-file.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import {
  type CreateImplementFlowOpts,
  effectiveDirtyTreePolicy,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';
import { forkCtx, implementBranchId } from '@src/application/flows/implement/merge-wave.ts';
import { resolveRepoOrThrow } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import {
  createPerTaskSubchain,
  type PerTaskSubchainOpts,
} from '@src/application/flows/implement/leaves/per-task-subchain.ts';
import { abortedStep, foldStep } from '@src/application/flows/implement/worktree-fold.ts';
import {
  foldQuarantinePointer,
  snapshotQuarantinedDiff,
  teardownWorktree,
  type WorktreeTeardownArgs,
} from '@src/application/flows/implement/worktree-teardown.ts';
import { beginWorktreeSetupTreeCheck } from '@src/application/flows/implement/worktree-setup-tree.ts';

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
 *  - setup: prune stale bookkeeping + drop any leaked ref (both defensive), then
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
 *    would strand that work in the reflog until GC. The keep is a recovery WINDOW, not permanence:
 *    `setupWorktree`'s defensive `gitDeleteBranch` drops the ref on that task's next launch.
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
    async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
      const gitRunner = deps.implement.gitRunner;
      const quarantinedAtStart = await snapshotQuarantinedDiff(deps, repoRoot, ctx.sprintId, taskId);
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
        const setupBlocked = await runWorktreeSetupScript(deps, worktreePath, setup, taskId, ctx, signal, onTrace);
        result = setupBlocked ?? (await body.execute(ctx, signal, onTrace));
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

/** The per-worktree setup a branch runs: the repo's script plus what its working-tree check needs. */
interface WorktreeSetupSpec {
  readonly script: string;
  /** Keys the main checkout's recorded answer in `ctx.setupTreeRecords`. */
  readonly repositoryId: RepositoryId;
  readonly policy: DirtyTreePolicy;
}

/**
 * Run the repo's `setupScript` inside the freshly-created worktree, before the per-task subchain.
 * A git worktree is a bare checkout: `node_modules`, `target/`, `.venv`, build caches — none of it
 * is present (those paths are git-ignored and not copied). The per-task `verifyScript` runs pre-
 * AND post-task in THIS worktree, so without a per-worktree setup it would fail as
 * `baseline-broken` / `regressed` and block legitimate work. The prologue's once-per-repo setup
 * preps the MAIN repo, not these throwaway worktrees, so it cannot cover this.
 *
 * The script is bracketed by a working-tree check (`beginWorktreeSetupTreeCheck`): anything it
 * writes that git doesn't ignore would otherwise be swept into the task commit by `git add -A`.
 * What the operator already saw in the main checkout is discarded here; anything else blocks the
 * task (or, under policy `continue`, stays with a warning). The main checkout itself is never read
 * — sibling folds change it mid-wave — only its recorded answer on `ctx.setupTreeRecords`.
 *
 * Returns `undefined` when there is no setup script, or it succeeded and the check let the task
 * through (the caller proceeds to the body). Otherwise it BLOCKS only this task and returns a
 * narrowed `Result.ok` carrying the blocked task — on a non-zero exit, timeout or spawn error, a
 * refused change, or a git status that can't be read — siblings run in their own worktrees and are
 * untouched, and the wave is NEVER hard-aborted (unlike the prologue's main-repo setup gate, whose
 * hard-abort semantics are wrong for one isolated worktree). A user abort that races the setup
 * propagates verbatim, never a block.
 */
const runWorktreeSetupScript = async (
  deps: BuildWaveBranchesDeps,
  worktreePath: AbsolutePath,
  setup: WorktreeSetupSpec | undefined,
  taskId: TaskId,
  ctx: ImplementCtx,
  signal: AbortSignal | undefined,
  onTrace: OnTrace | undefined
): Promise<ElementResult<ImplementCtx> | undefined> => {
  if (setup === undefined) return undefined;
  const name = `worktree-setup-script-${String(taskId)}`;
  const aborted = (): boolean => signal?.aborted === true;
  // Don't burn an install while the user is already aborting.
  if (aborted()) return abortedStep(name, 0, onTrace);

  const start = performance.now();
  const elapsed = (): number => performance.now() - start;
  const blockTask = (reason: string): ElementResult<ImplementCtx> =>
    blockTaskInWorktree(deps, ctx, taskId, name, elapsed(), reason, onTrace);
  const settleTree = await beginWorktreeSetupTreeCheck(deps.implement, {
    cwd: worktreePath,
    command: setup.script,
    policy: setup.policy,
    record: ctx.setupTreeRecords?.get(setup.repositoryId),
  });
  if (!settleTree.ok) {
    return blockTask(
      `worktree setup script not run — could not read the worktree's git status: ${settleTree.error.message}`
    );
  }
  const failure = await spawnWorktreeSetup(deps, worktreePath, setup.script, signal);
  // A user abort surfaces as the runner's AbortError (signal threaded into the spawn) — and may also
  // race the setup's natural failure — so check the signal before treating anything as a real outcome.
  if (aborted()) return abortedStep(name, elapsed(), onTrace);
  if (failure !== undefined) return blockTask(failure);
  const verdict = await settleTree.value();
  if (aborted()) return abortedStep(name, elapsed(), onTrace);
  if (verdict.kind === 'block') return blockTask(verdict.reason);
  onTrace?.({ elementName: name, status: 'completed', durationMs: elapsed() });
  return undefined;
};

/** Spawn the worktree's setup script. Returns the block reason when it didn't pass, else `undefined`. */
const spawnWorktreeSetup = async (
  deps: BuildWaveBranchesDeps,
  worktreePath: AbsolutePath,
  script: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> => {
  // Thread the chain abort signal into the runner so a Ctrl-C mid-setup kills the child promptly
  // instead of waiting out the shell timeout while the wave holds its worktree.
  const ran = await deps.implement.shellScriptRunner.run(worktreePath, script, signal !== undefined ? { signal } : {});
  if (ran.ok && ran.value.passed) return undefined;
  const detail = ran.ok ? `exit ${String(ran.value.exitCode ?? 'null')}` : ran.error.message;
  return `worktree setup script failed (${detail}) — the task could not be prepared in its isolated worktree`;
};

/**
 * Block THIS task after its per-worktree setup failed or its working-tree check refused, and
 * narrow the ctx to it. Setup runs before the subchain, so the task is still `todo`/`in_progress` —
 * `markTaskBlocked` (which accepts only those states) is the clean domain transition (no
 * hand-projection like `worktree-fold.ts`'s `blockTaskForFoldConflict`, which exists only because a
 * fold conflict re-blocks an already-`done` task). Returns `Result.ok` so the branch runner COMPLETES with the block in its ctx — `mergeImplementWave` overlays this
 * branch's OWNED task (see `ownedTask` / `implementBranchId`) and `captureDurableFold` records it
 * the same way, so the block survives even an abort of a sibling wave. The subchain never runs, so
 * this is the only place the operator is told about the block.
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
  deps.implement.logger.warn('worktree setup blocked the task', { taskId: String(taskId), reason });
  const entry: TraceEntry = { elementName: name, status: 'failed', durationMs };
  onTrace?.(entry);
  const task = ctx.tasks?.find((t) => t.id === taskId);
  // No task in ctx (shouldn't happen — the wave carries the full list), or the task isn't in a
  // blockable state: carry ctx through so the reducer leaves base untouched and it resets/re-runs.
  if (task === undefined) return Result.ok({ ctx, trace: [entry] });
  // A per-worktree setup block is an own-failure block — the task couldn't be prepared, which a
  // relaunch / operator fix must address; it never cascade-clears via upstream unblock. Classified
  // explicitly: the setup script / repo state in the fresh worktree is what needs fixing, not the
  // model.
  const blocked = markTaskBlocked(task, reason, 'own', {
    blockCause: 'worktree-setup-failure',
    faultSide: 'environment',
  });
  if (!blocked.ok) return Result.ok({ ctx, trace: [entry] });
  publishTaskBlocked(deps.eventBus, blocked.value, deps.implement.clock());
  // Narrow to THIS task only — belt-and-braces: the merge already reads only `ownedTask(branch.id,
  // ctx)`, so emitting siblings here can no longer clobber a concurrently-merged copy, but keeping
  // the ctx small costs nothing and matches the narrowing contract the branch body applies below.
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
