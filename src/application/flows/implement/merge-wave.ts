import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

import type { BranchOutcome } from '@src/application/chain/run/wave-scheduler.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { projectSprintScopedFields } from '@src/application/flows/implement/sprint-scoped-projection.ts';

/**
 * Whether a branch genuinely SETTLED its task, versus the scheduler killing it before it advanced.
 *
 * Per the {@link runWaves} contract, a branch the scheduler killed (fatal-sibling kill, or a wave
 * the launcher never reached) surfaces as `{ status: 'failed', error: undefined }`. That is "did
 * not complete" — NOT a real `blocked`. Only branches that actually ran their chain to a terminal
 * state carry an authoritative task copy worth overlaying:
 *
 *  - `status: 'completed'`                  → the branch's chain settled the task (done OR blocked).
 *  - `status: 'failed'` WITH an `error`     → a non-fatal branch error was absorbed; the branch's
 *                                             ctx holds the task transition (typically `blocked`).
 *  - `status: 'failed'` WITHOUT an `error`  → killed mid-flight / never started; leave base as-is so
 *                                             the launcher resets the task to `todo` and re-runs it.
 */
const branchSettled = <TCtx>(outcome: BranchOutcome<TCtx>): boolean =>
  outcome.status === 'completed' || outcome.error !== undefined;

/**
 * Fan-in reducer for one implement wave. Matches `WaveScheduleConfig<ImplementCtx>['merge']` so the
 * launcher can hand it straight to `runWaves`.
 *
 * Every wave partitions tasks DISJOINTLY (the scheduler runs one branch per task, and a wave only
 * groups tasks with no intra-wave dependency), so the task overlay is commutative: shuffling
 * `outcomes` produces an identical merged ctx. The reducer therefore needs no ordering guarantees
 * from the scheduler beyond "these outcomes all belong to the same wave."
 *
 *  - sprint-scoped fields → carried verbatim from `base` via {@link projectSprintScopedFields}.
 *  - `tasks` → `base.tasks` with each settled branch's task copy overlaid by id; an unsettled
 *    (killed) branch contributes nothing, leaving its base task untouched for reset/re-run.
 *  - per-task + signal-accum fields → reset to `undefined`; they have no meaning between waves.
 *
 * @public
 */
export const mergeImplementWave = (
  base: ImplementCtx,
  outcomes: ReadonlyArray<BranchOutcome<ImplementCtx>>
): ImplementCtx => {
  // Build the task-keyed overlay ONLY from branches that genuinely settled their task. A killed
  // branch (`failed` / no error) is skipped so its base task survives untouched and re-runs.
  const byId = new Map<TaskId, Task>();
  for (const outcome of outcomes) {
    if (!branchSettled(outcome)) continue;
    for (const task of outcome.ctx.tasks ?? []) byId.set(task.id, task);
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
