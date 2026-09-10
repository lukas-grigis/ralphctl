import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { OnTrace, TraceEntry } from '@src/application/chain/trace.ts';
import { gitFoldBranch } from '@src/integration/io/git-operations.ts';

import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { BuildWaveBranchesDeps } from '@src/application/flows/implement/wave-branch.ts';

/**
 * The serialised worktree-branch fold step, split out of `wave-branch.ts` as its own module: folding
 * onto the shared sprint branch and turning a cherry-pick conflict into a domain-level task block is
 * one self-contained concern (git fold → conflict → block-projection) that `wave-branch.ts`'s worktree
 * lifecycle (setup → subchain → fold → quarantine → cleanup) merely wires in as one step. `abortedStep`
 * moves alongside it because `foldStep` is its main caller; `wave-branch.ts`'s own abort check (the
 * per-worktree setup script racing a user abort) imports it back from here rather than duplicating it.
 */

/**
 * Build an `aborted` step result (AbortError propagated verbatim) — shared by the fold step below and
 * `wave-branch.ts`'s per-worktree setup-script step.
 */
export const abortedStep = (
  name: string,
  durationMs: number,
  onTrace: OnTrace | undefined
): ElementResult<ImplementCtx> => {
  const error = new AbortError({ elementName: name });
  const entry: TraceEntry = { elementName: name, status: 'aborted', durationMs, error };
  onTrace?.(entry);
  return Result.error({ error, trace: [entry] });
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
  // manual resolution, so it never cascade-clears via the upstream-unblock path. Classified
  // explicitly (not inferred): a fold conflict is a harness-side scheduling collision between two
  // concurrent branches, never the generator's fault, so it never spends a model-escalation rung.
  return {
    ...rest,
    status: 'blocked',
    blockedReason: reason,
    blockKind: 'own',
    blockCause: 'fold-conflict',
    faultSide: 'harness',
  };
};

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
export const foldStep = (
  deps: BuildWaveBranchesDeps,
  repoRoot: AbsolutePath,
  branchRef: string,
  taskId: TaskId
): Element<ImplementCtx> => ({
  name: `fold-${String(taskId)}`,
  async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
    const name = `fold-${String(taskId)}`;
    // An already-aborted signal takes priority over the "nothing to fold" fast path below: this
    // step's `Result.error(AbortError)` is how the branch's OVERALL result keeps reporting the
    // abort (`sequential` / the wave scheduler propagate it verbatim), even for a task that settled
    // `blocked` and never needed real fold work. `wave-branch.ts`'s worktree teardown does NOT rely
    // on this step's return value to see that settled ctx — its `onSettled` side-channel captures
    // it from the subchain directly, BEFORE this step ever runs — so aborting here costs nothing.
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
