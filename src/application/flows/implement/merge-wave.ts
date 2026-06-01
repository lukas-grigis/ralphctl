import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

import type { BranchOutcome } from '@src/application/chain/run/wave-scheduler.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';

/**
 * Classification of every {@link ImplementCtx} field for the parallel-wave fan-in.
 *
 *  - `'sprint'`       — sprint-scoped invariant; carried straight from `base` (the ctx that
 *                       entered the wave). Same across every branch.
 *  - `'tasks'`        — the task list; the only field a wave actually mutates. Folded as a
 *                       task-keyed overlay of every branch's settled task copy onto `base.tasks`.
 *  - `'per-task'`     — single-slot state scoped to ONE in-flight task. Meaningless between waves
 *                       (each branch carried its own); reset to `undefined` in the merged ctx.
 *  - `'signal-accum'` — per-attempt signal accumulators. Likewise per-branch; reset to `undefined`.
 */
type MergeClass = 'sprint' | 'tasks' | 'per-task' | 'signal-accum';

// Named so the classification map reads as labels, not repeated string literals.
const SPRINT = 'sprint' satisfies MergeClass;
const TASKS = 'tasks' satisfies MergeClass;
const PER_TASK = 'per-task' satisfies MergeClass;
const SIGNAL_ACCUM = 'signal-accum' satisfies MergeClass;

/**
 * THE exhaustiveness guard. A single object literal keyed over EVERY field of
 * {@link ImplementCtx}, `satisfies Record<keyof ImplementCtx, MergeClass>`. It is derived from the
 * interface, not a hand-maintained list: add a new field to `ImplementCtx` and this object stops
 * satisfying the constraint until the new field is classified here — a compile-time forcing
 * function so a future ctx field can never silently skip the merge/fork projection below.
 *
 * The merge/fork logic reads NOTHING from this object at runtime — it exists purely so the
 * classification is type-checked. The actual projection is hand-written below (and must be kept in
 * agreement with these labels), which is exactly the pairing the guard enforces.
 */
const _exhaustive = {
  // sprint-scoped → from base
  sprintId: SPRINT,
  sprint: SPRINT,
  execution: SPRINT,
  progressFile: SPRINT,
  // task list → overlay
  tasks: TASKS,
  // per-task single-slot → undefined
  taskWorkspaceRoot: PER_TASK,
  currentTaskId: PER_TASK,
  currentTask: PER_TASK,
  genEvalTurn: PER_TASK,
  currentRoundNum: PER_TASK,
  lastEvaluation: PER_TASK,
  plateauHistory: PER_TASK,
  lastExit: PER_TASK,
  lastVerdict: PER_TASK,
  lastBlockReason: PER_TASK,
  lastWarning: PER_TASK,
  lastShouldFailAttempt: PER_TASK,
  lastVerifyResult: PER_TASK,
  lastPreVerifyOutcome: PER_TASK,
  priorPostVerifyOutcome: PER_TASK,
  lastCommitSha: PER_TASK,
  proposedCommitMessage: PER_TASK,
  expectedBranch: PER_TASK,
  priorGeneratorSessionId: PER_TASK,
  priorEvaluatorSessionId: PER_TASK,
  // signal accumulators → undefined
  currentAttemptDecisions: SIGNAL_ACCUM,
  currentAttemptChanges: SIGNAL_ACCUM,
  currentAttemptLearnings: SIGNAL_ACCUM,
  currentAttemptNotes: SIGNAL_ACCUM,
} satisfies Record<keyof ImplementCtx, MergeClass>;

// Reference the guard so it is not dead-code-eliminated / lint-flagged; its whole purpose is the
// compile-time `satisfies` check above.
void _exhaustive;

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
 *  - sprint-scoped fields → carried verbatim from `base`.
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
    // sprint-scoped → base
    sprintId: base.sprintId,
    ...(base.sprint !== undefined ? { sprint: base.sprint } : {}),
    ...(base.execution !== undefined ? { execution: base.execution } : {}),
    ...(base.progressFile !== undefined ? { progressFile: base.progressFile } : {}),
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
 *  - sprint-scoped fields → carried from `base` (same sprint, execution, progress file).
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
    // sprint-scoped → base
    sprintId: base.sprintId,
    ...(base.sprint !== undefined ? { sprint: base.sprint } : {}),
    ...(base.execution !== undefined ? { execution: base.execution } : {}),
    ...(base.progressFile !== undefined ? { progressFile: base.progressFile } : {}),
    ...(base.tasks !== undefined ? { tasks: base.tasks } : {}),
    // per-task + signal-accum classes cleared (omitted → undefined); `priorPostVerifyOutcome`
    // dropped (accepted cost). `expectedBranch` is intentionally NOT set here — see the docstring:
    // the branch element omits `branch-preflight`, so leaving it `undefined` is correct.
  };

  return { ctx, repo: { ...repo, path: worktreePath } };
};
