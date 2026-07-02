import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { join } from 'node:path';

import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { OnTrace, TraceEntry } from '@src/application/chain/trace.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { WaveBranch } from '@src/application/chain/run/wave-scheduler.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { createPublishSignal, type PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import {
  gitDeleteBranch,
  gitFoldBranch,
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
 * `progress-journal-<taskId>`'s per-attempt SECTION write is a SEPARATE concern — it is a
 * read-modify-write of the WHOLE file (not this append port), so it is guarded by the dedicated
 * `journalMutex` instead (see `ProgressJournalLeafDeps` / `ImplementDeps`), not by this append
 * mutex. Per-task artefacts (`prompt.md`, `signals.json`) are written to task-scoped paths and
 * never collide, so only these two shared files need serialisation.
 *
 * @public
 */
export const serializeAppendFile = (inner: AppendFile): AppendFile => {
  const queue = createFoldQueue();
  return (path, text) => queue.run(() => inner(path, text));
};

/**
 * Project a fold-conflicted `done` task to `blocked`. A cherry-pick conflict means the worktree's
 * committed work is sound but cannot land on the shared sprint branch without manual resolution —
 * the task must surface as `blocked` so the operator sees it and a relaunch re-attempts it.
 *
 * The domain `markTaskBlocked` guards against re-blocking a `done` task (it only accepts
 * `todo`/`in_progress`), and there is no `done → blocked` lifecycle transition — re-blocking a
 * verified task is a parallel-fold concern the domain pre-dates. This is an application-layer ctx
 * projection (the merge/fork reducers already manipulate ctx task shapes directly): strip the
 * `DoneTask`-only `finalAttemptN`, stamp `status: 'blocked'` + the conflict reason.
 */
const blockTaskForFoldConflict = (task: Task, reason: string): BlockedTask => {
  // Drop the `DoneTask`-only `finalAttemptN` (absent on `BlockedTask`) and any existing
  // `blockedReason`; re-stamp `status` + the conflict reason. The rest of the `TaskBase` fields
  // (id, name, attempts, dependsOn, …) carry across unchanged.
  const {
    status: _status,
    finalAttemptN: _finalAttemptN,
    blockedReason: _blockedReason,
    ...rest
  } = task as Task & {
    readonly finalAttemptN?: number;
    readonly blockedReason?: string;
  };
  void _status;
  void _finalAttemptN;
  void _blockedReason;
  // A fold conflict is an own-failure block — the worktree's work is sound but can't land without
  // manual resolution, so it never cascade-clears via the upstream-unblock path.
  return { ...rest, status: 'blocked', blockedReason: reason, blockKind: 'own' };
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
 * cleanup. The element is a hand-written {@link Element} (NOT a chain primitive — §14) rather than a
 * plain `sequential`, because worktree-cleanup MUST run on EVERY exit path including abort: a plain
 * `sequential` skips downstream children once a child aborts, which would strand the worktree. This
 * adapter runs cleanup in a `finally`-style guarantee and forwards the inner result (AbortError
 * verbatim).
 *
 *  - setup: prune stale bookkeeping + drop any leaked ref (both defensive), then
 *    `git worktree add -b <ref> <path>` forked from the sprint branch tip.
 *  - setup script: run the repo's `setupScript` IN the worktree (a fresh checkout has no build
 *    deps). Failure blocks ONLY this task; it never hard-aborts the wave. Skipped when the repo
 *    configures no setup script.
 *  - body: the forked per-task subchain (rooted on the worktree via `forkCtx`, branch-preflight
 *    omitted) followed by the serialised fold.
 *  - cleanup: `git worktree remove --force` + `branch -D <ref>` — best-effort (the commits are
 *    already folded; a left-over worktree is scratch). A cleanup failure is logged, never fails the branch.
 */
const withWorktree = (
  deps: BuildWaveBranchesDeps,
  repoRoot: AbsolutePath,
  worktreePath: AbsolutePath,
  branchRef: string,
  taskId: TaskId,
  setupScript: string | undefined,
  body: Element<ImplementCtx>
): Element<ImplementCtx> => ({
  name: `worktree(${String(taskId)})`,
  children: [body],
  async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
    const gitRunner = deps.implement.gitRunner;
    const setupError = await setupWorktree(gitRunner, repoRoot, worktreePath, branchRef, taskId, onTrace);
    if (setupError !== undefined) {
      // A worktree that never got created has nothing to clean up — return the setup failure as-is
      // (non-fatal → the wave reducer leaves this task untouched so it resets/re-runs).
      return setupError;
    }

    let result: ElementResult<ImplementCtx>;
    try {
      // Per-worktree setup runs INSIDE the freshly-created worktree, before the task's subchain.
      // A git worktree is an empty checkout with no build artefacts, so the per-task verifyScript
      // would fail spuriously without it. `undefined` (block this task) short-circuits the body;
      // cleanup below still runs.
      const setupBlocked = await runWorktreeSetupScript(deps, worktreePath, setupScript, taskId, ctx, signal, onTrace);
      result = setupBlocked ?? (await body.execute(ctx, signal, onTrace));
    } finally {
      // Cleanup ALWAYS runs — success, non-fatal failure, or abort. The worktree's commits are
      // already folded by the body's fold step, so a forced remove only drops scratch state.
      await cleanupWorktree(gitRunner, repoRoot, worktreePath, branchRef, taskId, onTrace, deps.implement);
    }
    return result;
  },
});

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
 * those states) is the clean domain transition (no hand-projection like `blockTaskForFoldConflict`,
 * which exists only because a fold conflict re-blocks an already-`done` task). Returns `Result.ok`
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
  // relaunch / operator fix must address; it never cascade-clears via upstream unblock.
  const blocked = markTaskBlocked(task, reason, 'own');
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
  deps: ImplementDeps
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
 * The serialised fold step. Folds the worktree branch onto the shared sprint branch through the
 * shared {@link FoldQueue} (one fold at a time across all branches), in `base.tasks` order.
 *
 *  - Only `done` tasks fold — a `blocked` task's worktree carries no landable commit (the commit
 *    guard skipped), so there is nothing to fold and folding would be a no-op fast-forward.
 *  - A cherry-pick CONFLICT (`gitFoldBranch` returns a `StorageError`) transitions THIS task to
 *    `blocked` in the branch ctx and returns `Result.ok` carrying the blocked task — so the branch
 *    runner COMPLETES (its `runner.ctx` holds the block) and `mergeImplementWave` overlays it. The
 *    already-folded siblings stay landed (`gitFoldBranch` already ran `cherry-pick --abort`, so the
 *    sprint branch is left clean). A conflict is a domain decision (the work can't land), not an
 *    infrastructure abort — mirrors how the subchain settles a self-block without failing the chain.
 *  - AbortError is exempt: a mid-fold abort returns `Result.error(AbortError)` verbatim, never a block.
 */
/** Build an `aborted` step result (AbortError propagated verbatim) — shared by the fold + setup steps. */
const abortedStep = (name: string, durationMs: number, onTrace: OnTrace | undefined): ElementResult<ImplementCtx> => {
  const error = new AbortError({ elementName: name });
  const entry: TraceEntry = { elementName: name, status: 'aborted', durationMs, error };
  onTrace?.(entry);
  return Result.error({ error, trace: [entry] });
};

const foldStep = (
  deps: BuildWaveBranchesDeps,
  repoRoot: AbsolutePath,
  branchRef: string,
  taskId: TaskId
): Element<ImplementCtx> => ({
  name: `fold-${String(taskId)}`,
  async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
    const name = `fold-${String(taskId)}`;
    if (signal?.aborted) return abortedStep(name, 0, onTrace);

    const task = ctx.tasks?.find((t) => t.id === taskId);
    // Only a task the subchain settled `done` has a commit worth folding. Anything else (blocked,
    // or never settled) skips the fold and carries ctx through unchanged.
    if (task === undefined || task.status !== 'done') {
      const entry: TraceEntry = { elementName: name, status: 'completed', durationMs: 0 };
      onTrace?.(entry);
      return Result.ok({ ctx, trace: [entry] });
    }

    const start = performance.now();
    const folded = await deps.foldQueue.run(() => gitFoldBranch(deps.implement.gitRunner, repoRoot, branchRef));
    const durationMs = performance.now() - start;

    if (folded.ok) {
      const entry: TraceEntry = { elementName: name, status: 'completed', durationMs };
      onTrace?.(entry);
      return Result.ok({ ctx, trace: [entry] });
    }
    // A user abort that raced the fold propagates verbatim, never becomes a per-task block.
    // `gitFoldBranch` only ever returns a `StorageError`, so the only abort source is the outer signal.
    if (signal?.aborted) return abortedStep(name, durationMs, onTrace);

    return conflictFold(deps, ctx, task, branchRef, taskId, name, durationMs, folded.error, onTrace);
  },
});

/**
 * Handle a non-abort fold failure (a cherry-pick conflict). Blocks THIS task, leaves siblings
 * folded. Returns `Result.ok` with the blocked task so the branch runner COMPLETES and its
 * `runner.ctx` carries the block — `mergeImplementWave` overlays a `completed` branch's task copy.
 * (A `Result.error` here would leave `runner.ctx` at its pre-fold value, re-surfacing the task as
 * `done` in the merge, which would orphan the unmerged commit.)
 */
const conflictFold = (
  deps: BuildWaveBranchesDeps,
  ctx: ImplementCtx,
  task: Task,
  branchRef: string,
  taskId: TaskId,
  name: string,
  durationMs: number,
  error: DomainError,
  onTrace: OnTrace | undefined
): ElementResult<ImplementCtx> => {
  const reason = `fold conflict — worktree branch '${branchRef}' could not land on the sprint branch: ${error.message}`;
  const blocked = blockTaskForFoldConflict(task, reason);
  const tasks = ctx.tasks?.map((t) => (t.id === taskId ? blocked : t)) ?? [blocked];
  deps.implement.logger.warn('fold conflict — task blocked', { taskId: String(taskId), branchRef });
  const entry: TraceEntry = { elementName: name, status: 'failed', durationMs, error };
  onTrace?.(entry);
  return Result.ok({ ctx: { ...ctx, tasks }, trace: [entry] });
};

/**
 * Build the per-wave `WaveBranch[]` arrays for the parallel implement path.
 *
 * One {@link WaveBranch} per task: its element is the worktree adapter wrapping a `sequential` of
 * the forked per-task subchain + the serialised fold. `forkCtx` clears per-task ctx and points the
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
  // run's shared `journalMutex`, is inherited from `deps.implement`.
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
    },
    evaluator: {
      providerId: opts.evaluatorProviderId,
      model: opts.evaluatorModel,
      ...(opts.evaluatorEffort !== undefined ? { effort: opts.evaluatorEffort } : {}),
    },
    memoryRoot: opts.memoryRoot,
    projectId: opts.projectId,
    projectSlug: opts.projectSlug,
    includeBranchPreflight: false,
  };

  // The per-task subchain is built fresh on the FORKED ctx + worktree repo each time the branch
  // executes (so a re-merged wave ctx flows in). `buildSubchain` captures everything needed.
  const buildSubchain = (worktreeRepo: RepoExecConfig): Element<ImplementCtx> =>
    createPerTaskSubchain(branchDeps, subchainOpts, task, worktreeRepo, readConfig);

  return {
    id: `task-${String(task.id)}`,
    element: buildWorktreeBranch(deps, repo, task, worktreePath, branchRef, buildSubchain),
  };
};

/**
 * Assemble the worktree-wrapped branch element from a subchain FACTORY. The factory receives the
 * worktree-pointed {@link RepoExecConfig} and returns the per-task body element to run inside the
 * worktree. Exposed (not inlined) so tests can substitute a fake subchain — the worktree
 * setup/fold/cleanup + ctx-fork wiring is exercised independently of the real per-task chain.
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
  buildSubchain: (worktreeRepo: RepoExecConfig) => Element<ImplementCtx>
): Element<ImplementCtx> => {
  const body: Element<ImplementCtx> = {
    name: `task-${String(task.id)}-branch-body`,
    children: [],
    async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
      // Fork the carried base ctx onto the worktree at EXECUTE time, so the branch sees the most
      // recent merged ctx (sprint/tasks). `forkCtx` clears per-task state + drops the
      // verify-baseline; the returned repo points at the worktree.
      const { ctx: forkedCtx, repo: worktreeRepo } = forkCtx(ctx, repo, worktreePath);
      const subchain = buildSubchain(worktreeRepo);
      const fold = foldStep(deps, repo.path, branchRef, task.id);
      const inner = sequential<ImplementCtx>(`task-${String(task.id)}-fold-and-settle`, [subchain, fold]);
      const result = await inner.execute(forkedCtx, signal, onTrace);
      if (!result.ok) return result;
      // Narrow this branch's outcome ctx to carry ONLY its OWN task. `forkCtx` seeds `tasks` with the
      // full base list (so the subchain leaves can look up sibling deps), but the subchain only
      // settles THIS task; the others remain at their pre-wave status. `mergeImplementWave` overlays
      // EVERY task in each branch's outcome ctx onto `base.tasks` by id — so leaving the siblings in
      // would let a later-processed branch overwrite an earlier branch's settled task with a stale
      // copy. Emitting only the owned task makes the overlay disjoint + commutative (the wave-merge contract).
      const own = result.value.ctx.tasks?.find((t) => t.id === task.id);
      const narrowed: ImplementCtx = { ...result.value.ctx, ...(own !== undefined ? { tasks: [own] } : {}) };
      return Result.ok({ ctx: narrowed, trace: result.value.trace });
    },
  };
  return withWorktree(deps, repo.path, worktreePath, branchRef, task.id, repo.setupScript, body);
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
