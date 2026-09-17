import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

import type { BranchOutcome } from '@src/application/chain/run/wave-scheduler.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { projectSprintScopedFields } from '@src/application/flows/implement/sprint-scoped-projection.ts';

/**
 * The one place the `task-<id>` branch-id convention is spelled out. `buildOneBranch`
 * (`wave-branch.ts`) stamps every `WaveBranch.id` with this, and {@link ownedTask} decodes it back
 * to find the task a branch's outcome ctx actually settled. Keeping both directions behind one
 * function makes branch ↔ task ownership a single source of truth instead of two call sites that
 * happen to agree on a string template.
 *
 * @public
 */
export const implementBranchId = (taskId: TaskId): string => `task-${String(taskId)}`;

/**
 * The task a branch's outcome ctx OWNS, keyed by decoding {@link implementBranchId} against
 * `ctx.tasks`. A branch's ctx nominally carries the FULL task list (`forkCtx` seeds it that way so
 * per-task leaves can look up sibling dependencies), but only the branch's own task is ever an
 * authoritative transition — every reader that wants a branch's settled task goes through this
 * function rather than trusting the whole list.
 *
 * @public
 */
export const ownedTask = (branchId: string, ctx: ImplementCtx): Task | undefined =>
  ctx.tasks?.find((t) => implementBranchId(t.id) === branchId);

/**
 * Reconcile the in-memory (post-merge) task list against what is DURABLY persisted on disk, for
 * exactly one class of divergence: a task a non-completed branch left `todo` / `in_progress` in
 * memory, whose persisted row is `blocked`. That divergence is not a race — it is the documented
 * shape of a branch whose chain persisted a block (`start-attempt`'s resume-budget exhaustion,
 * `settle-attempt`'s block, the dependency gate's `blocked upstream` write) and THEN errored or
 * aborted before its runner reached `completed`: `mergeImplementWave` skips a non-`completed`
 * outcome entirely, so the in-memory copy reverts to the wave's pre-branch base while the leaf's
 * own write already landed the block (and, for a quarantined diff, its stash pointer) on disk.
 * Without this step the epilogue's `saveTasksLeaf` overwrites that persisted block with the stale
 * in-memory copy, and the next launch re-enters the same task, re-blocks, and re-notifies forever.
 *
 * A fold-conflict block is not one of these. `conflictFold` (`worktree-fold.ts`) writes nothing to
 * the task repository and lets the branch complete, so that block lives only in the completed
 * branch's ctx and reaches disk through the {@link mergeImplementWave} overlay and `saveTasksLeaf`.
 *
 * Deliberately narrow, in both directions:
 *  - only a persisted `'blocked'` row is ever adopted — a persisted `'done'` is NEVER pulled in
 *    over an in-memory `todo`/`in_progress`, because that would let an unfolded commit skip
 *    re-running instead of retrying (the same "only a `completed` branch's fold is durable"
 *    contract `worktree-teardown.ts` relies on for `keepBranchRefReason`);
 *  - an in-memory task that is already `'done'` or `'blocked'` is left untouched — it settled
 *    inside THIS run and is authoritative over whatever an older disk row says.
 *
 * @public
 */
export const adoptPersistedBlocks = (tasks: readonly Task[], persisted: readonly Task[]): readonly Task[] => {
  const persistedBlocked = new Map<TaskId, Task>();
  for (const task of persisted) {
    if (task.status === 'blocked') persistedBlocked.set(task.id, task);
  }
  return tasks.map((task) => {
    if (task.status !== 'todo' && task.status !== 'in_progress') return task;
    return persistedBlocked.get(task.id) ?? task;
  });
};

/**
 * Fan-in reducer for one implement wave. Matches `WaveScheduleConfig<ImplementCtx>['merge']` so the
 * launcher can hand it straight to `runWaves`.
 *
 * Overlays base.tasks with ONLY the tasks that a branch genuinely, durably settled — every other
 * task (including any in a `failed` branch's ctx) carries straight through from `base` untouched:
 *
 *  - `status === 'completed'` → the branch's chain ran to a real terminal state (done, a
 *    self-block, or a fold conflict). Its {@link ownedTask} is the one and only task this branch
 *    contributes.
 *  - `status === 'failed'` → per the {@link runWaves} / {@link BranchOutcome} contract, `ctx` here
 *    is the runner's OWN `initialCtx` (the runner never advances `ctx` on a failed step) — it is
 *    NOT a transition, whether or not `error` is present. Overlaying it would revert this branch's
 *    task to its pre-wave status and — because `initialCtx` carries the FULL base task list, not
 *    just this branch's own task — would ALSO revert every sibling the branch's ctx happens to
 *    still be carrying, including one that another branch in the SAME wave already completed. A
 *    `failed` branch therefore contributes NOTHING; a leaf that persisted a block before the branch
 *    errored is picked back up by `adoptPersistedBlocksLeaf` in the epilogue, not here.
 *
 * This overlay-only-`completed` rule is exactly what makes the merge disjoint and commutative:
 * shuffling `outcomes` produces an identical merged ctx, because each `completed` branch
 * contributes exactly the one task it owns and nothing else can collide with it.
 *
 *  - sprint-scoped fields → carried verbatim from `base` via {@link projectSprintScopedFields}.
 *  - per-task + signal-accum fields → reset to `undefined`; they have no meaning between waves.
 *
 * @public
 */
export const mergeImplementWave = (
  base: ImplementCtx,
  outcomes: ReadonlyArray<BranchOutcome<ImplementCtx>>
): ImplementCtx => {
  const byId = new Map<TaskId, Task>();
  for (const outcome of outcomes) {
    if (outcome.status !== 'completed') continue;
    const owned = ownedTask(outcome.id, outcome.ctx);
    if (owned !== undefined) byId.set(owned.id, owned);
  }

  const tasks = base.tasks?.map((t) => byId.get(t.id) ?? t);

  return {
    ...projectSprintScopedFields(base),
    // task list → overlay
    ...(tasks !== undefined ? { tasks } : {}),
    // per-task + signal-accum classes intentionally omitted → undefined in the merged ctx.
  };
};

/**
 * Per-branch fork of the implement ctx, scoped to ONE task's worktree run. Produced by the launcher
 * before it builds the branch's per-task sub-chain, then handed to the wave scheduler as the
 * branch's `initialCtx`.
 *
 * Returns BOTH the forked ctx and a worktree-pointed {@link RepoExecConfig}. The repo path is NOT an
 * `ImplementCtx` field — it lives on the implement flow's construction opts (`CreateImplementFlowOpts.
 * repositories`), bound into the per-task leaves at build time. So redirecting a branch onto its
 * worktree means handing the caller a `RepoExecConfig` whose `path` is the worktree path; the caller
 * uses it to construct the branch element. Returning it here keeps the per-branch derivation in one
 * pure place rather than splitting ctx-clearing from repo-redirection across the launcher.
 *
 * Projection:
 *  - sprint-scoped fields → carried from `base` via {@link projectSprintScopedFields} (same sprint,
 *    execution, progress file).
 *  - per-task single-slot + signal-accum classes → cleared (`undefined`); a fresh branch starts a
 *    fresh task with no carried per-attempt state.
 *  - `priorPostVerifyOutcome` → DROPPED (accepted cost): a parallel branch starts on its own
 *    worktree with no carried pre-task-verify baseline, so the pre-task-verify short-circuit is
 *    lost and verifyScript re-runs per task. This is the documented parallel trade-off.
 *  - `expectedBranch` → LEFT UNDEFINED (corrected). An earlier draft wrote `expectedBranch: ''`
 *    intending to disable per-task `branch-preflight`, but that leaf short-circuits on `undefined`,
 *    not `''` — the empty string would NOT actually disable it. The branch element omits
 *    `branch-preflight` entirely (each worktree is checked out on its own ref, so the preflight is
 *    moot and would fail), so the field is simply cleared like the rest of the per-task class: no
 *    downstream reader can mis-fire on a stale `''`.
 *  - repo path → the task's worktree path on the returned `RepoExecConfig`.
 *
 * @public
 */
export const forkCtx = (
  base: ImplementCtx,
  repo: RepoExecConfig,
  worktreePath: AbsolutePath
): { readonly ctx: ImplementCtx; readonly repo: RepoExecConfig } => {
  const ctx: ImplementCtx = {
    ...projectSprintScopedFields(base),
    ...(base.tasks !== undefined ? { tasks: base.tasks } : {}),
    // per-task + signal-accum classes cleared (omitted → undefined); `priorPostVerifyOutcome`
    // dropped (accepted cost). `expectedBranch` is intentionally NOT set here — see the docstring:
    // the branch element omits `branch-preflight`, so leaving it `undefined` is correct.
  };

  return { ctx, repo: { ...repo, path: worktreePath } };
};
