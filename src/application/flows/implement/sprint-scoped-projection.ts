import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Classification of every {@link ImplementCtx} field for the parallel-wave fan-in
 * (`mergeImplementWave`) and per-branch fork (`forkCtx`) — both in `merge-wave.ts`.
 *
 *  - `'sprint'`       — sprint-scoped invariant; carried straight from `base` (the ctx that entered
 *                       the wave / that a branch forked from). Same across every branch. Projected
 *                       by {@link projectSprintScopedFields} below — the ONLY place either caller
 *                       reads these fields off `base`.
 *  - `'tasks'`        — the task list. `mergeImplementWave` folds it as a task-keyed overlay;
 *                       `forkCtx` carries it straight through so per-task leaves can look up sibling
 *                       deps. The two callers genuinely compute different values for it, so it is
 *                       classified here (for the exhaustiveness check) but NOT part of the shared
 *                       sprint-scoped projection.
 *  - `'per-task'`     — single-slot state scoped to ONE in-flight task. Meaningless between waves
 *                       (each branch carried its own); both callers reset it to `undefined` by
 *                       omission.
 *  - `'signal-accum'` — per-attempt signal accumulators. Likewise per-branch; reset to `undefined`.
 */
type MergeClass = 'sprint' | 'tasks' | 'per-task' | 'signal-accum';

// Named so the classification map reads as labels, not repeated string literals.
const SPRINT = 'sprint' satisfies MergeClass;
const TASKS = 'tasks' satisfies MergeClass;
const PER_TASK = 'per-task' satisfies MergeClass;
const SIGNAL_ACCUM = 'signal-accum' satisfies MergeClass;

/**
 * THE exhaustiveness guard. A single object literal keyed over EVERY field of {@link ImplementCtx},
 * `satisfies Record<keyof ImplementCtx, MergeClass>`. It is derived from the interface, not a
 * hand-maintained list: add a new field to `ImplementCtx` and this object stops satisfying the
 * constraint until the new field is classified here.
 *
 * Classifying a field `'sprint'` here is necessary but not, on its own, sufficient to make it
 * project — see {@link SprintScopedKey} / {@link projectSprintScopedFields}, which is the part of
 * the guard that actually forces the projection function to keep up with this classification.
 */
const CTX_FIELD_CLASS = {
  // sprint-scoped → projected by projectSprintScopedFields
  sprintId: SPRINT,
  sprint: SPRINT,
  execution: SPRINT,
  progressFile: SPRINT,
  setupVerifiedRepoIdsThisRun: SPRINT,
  // Loaded once in the prologue; every branch reads the same cross-sprint memory → run-scoped.
  priorLearnings: SPRINT,
  // task list → each caller projects its own value (overlay vs straight carry)
  tasks: TASKS,
  // per-task single-slot → undefined
  taskWorkspaceRoot: PER_TASK,
  currentTaskId: PER_TASK,
  currentTask: PER_TASK,
  genEvalTurn: PER_TASK,
  currentRoundNum: PER_TASK,
  lastEvaluation: PER_TASK,
  plateauHistory: PER_TASK,
  // Per-turn signal-kind distribution for the in-flight task's current gen-eval turn — meaningless
  // between waves (each branch carries its own), reset to undefined in the merged/forked ctx.
  lastTurnActionCounts: PER_TASK,
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
  // Corrective-nudge tallies — same per-attempt lifecycle as the signal accumulators above.
  currentAttemptGeneratorNudges: SIGNAL_ACCUM,
  currentAttemptEvaluatorNudges: SIGNAL_ACCUM,
} satisfies Record<keyof ImplementCtx, MergeClass>;

// Reference the guard so it is not dead-code-eliminated / lint-flagged; its whole purpose is the
// compile-time `satisfies` check above plus the `SprintScopedKey` type derived from it below.
void CTX_FIELD_CLASS;

/**
 * Keys of {@link ImplementCtx} classified `'sprint'` in {@link CTX_FIELD_CLASS} — derived by mapped
 * type over the classification object itself, never hand-listed, so it can't drift from it.
 */
type SprintScopedKey = {
  [K in keyof typeof CTX_FIELD_CLASS]: (typeof CTX_FIELD_CLASS)[K] extends typeof SPRINT ? K : never;
}[keyof typeof CTX_FIELD_CLASS];

/**
 * Project the sprint-scoped fields of `ctx` — carried verbatim across a wave merge
 * (`mergeImplementWave`) or a per-branch fork (`forkCtx`): the same sprint, execution, progress
 * file, and run-scoped setup/memory state applies to every branch of a wave and every wave of a run.
 *
 * The return type, `Required<Pick<ImplementCtx, SprintScopedKey>>`, is the actual compile-time
 * forcing function the `_exhaustive`-style guard alone can't provide: EVERY field classified
 * `'sprint'` above MUST be assigned explicitly below (present or not — each field's own type already
 * allows `undefined`, `Required` only strips the *optional* modifier so the key can't be silently
 * left out of the object literal). Reclassifying or adding a field to the `'sprint'` bucket widens
 * `SprintScopedKey`, which breaks THIS function's return type until the new field is projected here.
 * Because `mergeImplementWave` and `forkCtx` both build their sprint-scoped slice by calling this and
 * only this, neither can drift out of sync with the classification, or with each other.
 *
 * @public
 */
export const projectSprintScopedFields = (ctx: ImplementCtx): Required<Pick<ImplementCtx, SprintScopedKey>> => ({
  sprintId: ctx.sprintId,
  sprint: ctx.sprint,
  execution: ctx.execution,
  progressFile: ctx.progressFile,
  setupVerifiedRepoIdsThisRun: ctx.setupVerifiedRepoIdsThisRun,
  priorLearnings: ctx.priorLearnings,
});
