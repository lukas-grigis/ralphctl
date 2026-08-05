import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Classification of every {@link ImplementCtx} field along TWO independent axes, both enforced by
 * the same exhaustiveness guard (the `satisfies Record<keyof ImplementCtx, FieldClass>` check below):
 *
 *  - `merge`   — used by the parallel-wave fan-in (`mergeImplementWave`) and per-branch fork
 *                (`forkCtx`), both in `merge-wave.ts`:
 *     - `'sprint'`       — sprint-scoped invariant; carried straight from `base` (the ctx that
 *                          entered the wave / that a branch forked from). Same across every branch.
 *                          Projected by {@link projectSprintScopedFields} below — the ONLY place
 *                          either caller reads these fields off `base`.
 *     - `'tasks'`        — the task list. `mergeImplementWave` folds it as a task-keyed overlay;
 *                          `forkCtx` carries it straight through so per-task leaves can look up
 *                          sibling deps. The two callers genuinely compute different values for it,
 *                          so it is classified here (for the exhaustiveness check) but NOT part of
 *                          the shared sprint-scoped projection.
 *     - `'per-task'`     — single-slot state scoped to ONE in-flight task. Meaningless between
 *                          waves (each branch carried its own); both callers reset it to `undefined`
 *                          by omission.
 *     - `'signal-accum'` — per-attempt signal accumulators. Likewise per-branch; reset to
 *                          `undefined`.
 *  - `attempt` — used by the per-attempt boundary leaves (`start-attempt`, `settle-attempt`) in
 *                `leaves/`:
 *     - `'reset'`        — scratch that only makes sense for the CURRENTLY-RUNNING attempt (turn
 *                          counter, plateau window, round pointer, latest evaluation, proposed
 *                          commit message, generator/evaluator session ids). Cleared by
 *                          {@link resetAttemptScratch}, which `start-attempt` spreads onto its
 *                          output so attempt 2 of a task never inherits attempt 1's scratch.
 *     - `'settle-reset'` — per-task verdict / turn-outcome state that settle-attempt clears once
 *                          the attempt has been settled (task identity, verdict, block reason,
 *                          exit, warning, verify result, commit sha). Cleared by
 *                          {@link resetSettleScratch}. Distinct from `'reset'`: settle-attempt runs
 *                          BEFORE `progress-journal` in the same loop iteration, and progress-journal
 *                          still needs to read `currentRoundNum` / `lastEvaluation` / etc — so those
 *                          fields must NOT be cleared yet at settle time. They wait for the next
 *                          `start-attempt`.
 *     - `'carry'`        — everything else: never cleared by either boundary. This includes the
 *                          `'signal-accum'` fields (merge axis) — those are cleared by
 *                          `progress-journal` instead, via {@link resetSignalAccumulators}, one step
 *                          BEFORE the next `start-attempt` runs, so by the time `start-attempt`
 *                          re-enters they are already `undefined`.
 */
type MergeClass = 'sprint' | 'tasks' | 'per-task' | 'signal-accum';
type AttemptClass = 'reset' | 'settle-reset' | 'carry';

interface FieldClass {
  readonly merge: MergeClass;
  readonly attempt: AttemptClass;
}

// Named so the classification map reads as labels, not repeated string literals.
const SPRINT = 'sprint' satisfies MergeClass;
const TASKS = 'tasks' satisfies MergeClass;
const PER_TASK = 'per-task' satisfies MergeClass;
const SIGNAL_ACCUM = 'signal-accum' satisfies MergeClass;

const RESET = 'reset' satisfies AttemptClass;
const SETTLE_RESET = 'settle-reset' satisfies AttemptClass;
const CARRY = 'carry' satisfies AttemptClass;

/**
 * THE exhaustiveness guard. A single object literal keyed over EVERY field of {@link ImplementCtx},
 * `satisfies Record<keyof ImplementCtx, FieldClass>`. It is derived from the interface, not a
 * hand-maintained list: add a new field to `ImplementCtx` and this object stops satisfying the
 * constraint until the new field is classified on BOTH axes here.
 *
 * Classifying a field here is necessary but not, on its own, sufficient to make it project — see
 * {@link SprintScopedKey} / {@link projectSprintScopedFields} (and the `attempt`-axis counterparts
 * below), which are the part of the guard that actually forces the projection functions to keep up
 * with this classification.
 */
const CTX_FIELD_CLASS = {
  // sprint-scoped → projected by projectSprintScopedFields
  sprintId: { merge: SPRINT, attempt: CARRY },
  sprint: { merge: SPRINT, attempt: CARRY },
  execution: { merge: SPRINT, attempt: CARRY },
  progressFile: { merge: SPRINT, attempt: CARRY },
  setupVerifiedRepoIdsThisRun: { merge: SPRINT, attempt: CARRY },
  // Loaded once in the prologue; every branch reads the same cross-sprint memory → run-scoped.
  priorLearnings: { merge: SPRINT, attempt: CARRY },
  // task list → each merge caller projects its own value (overlay vs straight carry); never
  // touched by either attempt boundary.
  tasks: { merge: TASKS, attempt: CARRY },
  // per-task single-slot → undefined between waves. `taskWorkspaceRoot` / `expectedBranch` are
  // re-stamped by their own per-task setter leaves every task, so neither attempt boundary needs
  // to clear them.
  taskWorkspaceRoot: { merge: PER_TASK, attempt: CARRY },
  // Cleared by settle-attempt: the task is no longer "current" once its attempt has settled.
  currentTaskId: { merge: PER_TASK, attempt: SETTLE_RESET },
  currentTask: { merge: PER_TASK, attempt: SETTLE_RESET },
  // Per-attempt loop scratch → cleared by start-attempt so the NEXT attempt starts fresh.
  genEvalTurn: { merge: PER_TASK, attempt: RESET },
  currentRoundNum: { merge: PER_TASK, attempt: RESET },
  lastEvaluation: { merge: PER_TASK, attempt: RESET },
  plateauHistory: { merge: PER_TASK, attempt: RESET },
  // Per-turn distribution of generator-emitted signal kinds for the turn just completed — reset
  // per attempt like the rest of the loop scratch above (previously never reset anywhere; the
  // entropy-plateau gate's `turnsUsed >= 3` guard was the only thing masking the leak across a
  // multi-attempt task).
  lastTurnActionCounts: { merge: PER_TASK, attempt: RESET },
  // Per-attempt verdict / turn-outcome state → cleared by settle-attempt once the attempt settles.
  lastExit: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastVerdict: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastBlockReason: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastWarning: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastShouldFailAttempt: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastVerifyResult: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastPreVerifyOutcome: { merge: PER_TASK, attempt: SETTLE_RESET },
  // Survives BOTH boundaries — carried across attempts and tasks so the NEXT task's pre-task-verify
  // can short-circuit on a still-clean tree. Dropped only by the parallel-path `forkCtx`.
  priorPostVerifyOutcome: { merge: PER_TASK, attempt: CARRY },
  lastCommitSha: { merge: PER_TASK, attempt: SETTLE_RESET },
  proposedCommitMessage: { merge: PER_TASK, attempt: RESET },
  expectedBranch: { merge: PER_TASK, attempt: CARRY },
  priorGeneratorSessionId: { merge: PER_TASK, attempt: RESET },
  priorEvaluatorSessionId: { merge: PER_TASK, attempt: RESET },
  // Set once per task (before the attempt loop) by the guarded `reproduce-<taskId>` leaf; must
  // survive every attempt/retry of the SAME task, so `CARRY` not `RESET`. Meaningless once the
  // task itself changes — `clearReproductionArtifactLeaf` is the serial-path counterpart of the
  // `PER_TASK` reset this classification already gives it on the parallel path.
  reproductionArtifact: { merge: PER_TASK, attempt: CARRY },
  // Best-of-N candidate accumulator — per-attempt loop scratch like `plateauHistory` above:
  // meaningless once the attempt that sampled it settles, so `start-attempt` clears it for the
  // next attempt and the parallel merge treats it as per-branch (never carried across a wave).
  bestOfNCandidates: { merge: PER_TASK, attempt: RESET },
  // Companion iteration counter — same per-attempt lifecycle as `bestOfNCandidates`.
  bestOfNSampledCount: { merge: PER_TASK, attempt: RESET },
  // Per-turn counter for the best-of-N composite's OWN loop — same per-attempt lifecycle as
  // `currentRoundNum` (which it exists to stop the round-1 gate depending on).
  bestOfNLoopTurn: { merge: PER_TASK, attempt: RESET },
  // Stamped once by `bestOfNSelectionLeaf` when the granted attempt's selection cascade closes
  // out — same per-attempt lifecycle as `bestOfNCandidates`.
  bestOfNSummary: { merge: PER_TASK, attempt: RESET },
  // signal accumulators → undefined between waves; cleared per-attempt by progress-journal
  // (resetSignalAccumulators), not by either attempt-boundary leaf directly.
  currentAttemptDecisions: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptChanges: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptLearnings: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptNotes: { merge: SIGNAL_ACCUM, attempt: CARRY },
  // Corrective-nudge tallies — same per-attempt lifecycle as the signal accumulators above.
  currentAttemptGeneratorNudges: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptEvaluatorNudges: { merge: SIGNAL_ACCUM, attempt: CARRY },
} satisfies Record<keyof ImplementCtx, FieldClass>;

// Reference the guard so it is not dead-code-eliminated / lint-flagged; its whole purpose is the
// compile-time `satisfies` check above plus the key types derived from it below.
void CTX_FIELD_CLASS;

/**
 * Keys of {@link ImplementCtx} classified `merge: 'sprint'` in {@link CTX_FIELD_CLASS} — derived by
 * mapped type over the classification object itself, never hand-listed, so it can't drift from it.
 */
type SprintScopedKey = {
  [K in keyof typeof CTX_FIELD_CLASS]: (typeof CTX_FIELD_CLASS)[K]['merge'] extends typeof SPRINT ? K : never;
}[keyof typeof CTX_FIELD_CLASS];

/**
 * Keys classified `attempt: 'reset'` — cleared by `start-attempt` at the top of every attempt. See
 * {@link resetAttemptScratch}.
 */
type AttemptResetKey = {
  [K in keyof typeof CTX_FIELD_CLASS]: (typeof CTX_FIELD_CLASS)[K]['attempt'] extends typeof RESET ? K : never;
}[keyof typeof CTX_FIELD_CLASS];

/**
 * Keys classified `attempt: 'settle-reset'` — cleared by `settle-attempt` once an attempt settles.
 * See {@link resetSettleScratch}.
 */
type SettleResetKey = {
  [K in keyof typeof CTX_FIELD_CLASS]: (typeof CTX_FIELD_CLASS)[K]['attempt'] extends typeof SETTLE_RESET ? K : never;
}[keyof typeof CTX_FIELD_CLASS];

/**
 * Keys classified `merge: 'signal-accum'` — cleared by `progress-journal` after it renders the
 * attempt's accumulated signals into the journal entry. See {@link resetSignalAccumulators}.
 */
type SignalAccumKey = {
  [K in keyof typeof CTX_FIELD_CLASS]: (typeof CTX_FIELD_CLASS)[K]['merge'] extends typeof SIGNAL_ACCUM ? K : never;
}[keyof typeof CTX_FIELD_CLASS];

/**
 * Project the sprint-scoped fields of `ctx` — carried verbatim across a wave merge
 * (`mergeImplementWave`) or a per-branch fork (`forkCtx`): the same sprint, execution, progress
 * file, and run-scoped setup/memory state applies to every branch of a wave and every wave of a run.
 *
 * The return type, `Required<Pick<ImplementCtx, SprintScopedKey>>`, is the actual compile-time
 * forcing function the `_exhaustive`-style guard alone can't provide: EVERY field classified
 * `merge: 'sprint'` above MUST be assigned explicitly below (present or not — each field's own type
 * already allows `undefined`, `Required` only strips the *optional* modifier so the key can't be
 * silently left out of the object literal). Reclassifying or adding a field to the `'sprint'` bucket
 * widens `SprintScopedKey`, which breaks THIS function's return type until the new field is
 * projected here. Because `mergeImplementWave` and `forkCtx` both build their sprint-scoped slice by
 * calling this and only this, neither can drift out of sync with the classification, or with each
 * other.
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

/**
 * The per-ATTEMPT scratch reset — every field classified `attempt: 'reset'` above, cleared to
 * `undefined`. `start-attempt` spreads this onto its output ALONGSIDE the fields it explicitly sets
 * (`currentTaskId` / `currentTask` / `tasks`), so a fresh attempt never inherits the prior attempt's
 * turn counter, plateau window, round pointer, latest evaluation, proposed commit message, or
 * generator/evaluator session ids — and, since `lastTurnActionCounts` is classified here too, never
 * inherits the prior attempt's last-turn signal-kind distribution either (the bug this classification
 * fixes: that field previously had no reset site at all).
 *
 * The return type, `Required<Pick<ImplementCtx, AttemptResetKey>>`, is the same compile-time forcing
 * function as {@link projectSprintScopedFields}: reclassifying or adding a field to the `'reset'`
 * bucket widens `AttemptResetKey`, which breaks this function's return type until the new field is
 * assigned here.
 *
 * Takes no `ctx` parameter — the reset always yields the same fixed set of `undefined` values
 * regardless of the attempt's prior state, so there is nothing to read off `ctx`.
 *
 * @public
 */
export const resetAttemptScratch = (): Required<Pick<ImplementCtx, AttemptResetKey>> => ({
  genEvalTurn: undefined,
  currentRoundNum: undefined,
  lastEvaluation: undefined,
  plateauHistory: undefined,
  lastTurnActionCounts: undefined,
  proposedCommitMessage: undefined,
  priorGeneratorSessionId: undefined,
  priorEvaluatorSessionId: undefined,
  bestOfNCandidates: undefined,
  bestOfNSampledCount: undefined,
  bestOfNLoopTurn: undefined,
  bestOfNSummary: undefined,
});

/**
 * The per-SETTLE reset — every field classified `attempt: 'settle-reset'` above, cleared to
 * `undefined`. `settle-attempt` spreads this onto its output alongside the settled task overlay it
 * writes onto `ctx.tasks`, so the just-settled task's identity and verdict scratch never leaks into
 * the next leaf's read of ctx.
 *
 * Deliberately DISTINCT from {@link resetAttemptScratch}: `settle-attempt` runs before
 * `progress-journal` in the same loop iteration, and `progress-journal` still needs
 * `ctx.currentRoundNum` / `ctx.lastEvaluation` / the rest of the `'reset'` bucket to render this
 * attempt's journal section. Those wait for the next `start-attempt`.
 *
 * @public
 */
export const resetSettleScratch = (): Required<Pick<ImplementCtx, SettleResetKey>> => ({
  currentTaskId: undefined,
  currentTask: undefined,
  lastExit: undefined,
  lastVerdict: undefined,
  lastBlockReason: undefined,
  lastWarning: undefined,
  lastShouldFailAttempt: undefined,
  lastVerifyResult: undefined,
  lastPreVerifyOutcome: undefined,
  lastCommitSha: undefined,
});

/**
 * The per-attempt signal-accumulator reset — every field classified `merge: 'signal-accum'` above,
 * cleared to `undefined`. `progress-journal` spreads this onto its output after rendering the
 * accumulated decisions / changes / learnings / notes / nudge tallies into the attempt's journal
 * section, so the NEXT attempt (or the next task) starts with empty accumulators.
 *
 * @public
 */
export const resetSignalAccumulators = (): Required<Pick<ImplementCtx, SignalAccumKey>> => ({
  currentAttemptDecisions: undefined,
  currentAttemptChanges: undefined,
  currentAttemptLearnings: undefined,
  currentAttemptNotes: undefined,
  currentAttemptGeneratorNudges: undefined,
  currentAttemptEvaluatorNudges: undefined,
});
