import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Every {@link ImplementCtx} field classified on two axes. Adding a ctx field breaks the
 * `satisfies` check until it is classified here.
 *
 * `merge` — the parallel-wave fan-in / fork in `merge-wave.ts`:
 *  - `sprint`       run-scoped; carried from `base` via {@link projectSprintScopedFields}.
 *  - `tasks`        the task list; the merge overlays it, the fork carries it.
 *  - `per-task`     one in-flight task's state; dropped between waves.
 *  - `signal-accum` per-attempt accumulators; dropped between waves.
 *
 * `attempt` — the per-attempt boundary leaves:
 *  - `reset`        cleared by `start-attempt` ({@link resetAttemptScratch}).
 *  - `settle-reset` cleared by `settle-attempt` ({@link resetSettleScratch}). Kept apart from `reset`
 *                   because `progress-journal` runs after settle and still reads the `reset` fields.
 *  - `carry`        never cleared by either boundary; the `signal-accum` fields are cleared by
 *                   `progress-journal` ({@link resetSignalAccumulators}) before the next attempt.
 */
interface FieldClass {
  readonly merge: 'sprint' | 'tasks' | 'per-task' | 'signal-accum';
  readonly attempt: 'reset' | 'settle-reset' | 'carry';
}

const SPRINT = 'sprint';
const PER_TASK = 'per-task';
const SIGNAL_ACCUM = 'signal-accum';
const RESET = 'reset';
const SETTLE_RESET = 'settle-reset';
const CARRY = 'carry';

const CTX_FIELD_CLASS = {
  sprintId: { merge: SPRINT, attempt: CARRY },
  sprint: { merge: SPRINT, attempt: CARRY },
  execution: { merge: SPRINT, attempt: CARRY },
  progressFile: { merge: SPRINT, attempt: CARRY },
  setupVerifiedRepoIdsThisRun: { merge: SPRINT, attempt: CARRY },
  // The main checkout's recorded post-setup answer — every task worktree of every wave reads it.
  setupTreeRecords: { merge: SPRINT, attempt: CARRY },
  // Loaded once in the prologue; every branch reads the same cross-sprint memory → run-scoped.
  priorLearnings: { merge: SPRINT, attempt: CARRY },
  // task list → each merge caller projects its own value (overlay vs straight carry); never
  // touched by either attempt boundary.
  tasks: { merge: 'tasks', attempt: CARRY },
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
  // Per-attempt verdict / turn-outcome state → cleared by settle-attempt once the attempt settles.
  lastExit: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastVerdict: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastBlockReason: { merge: PER_TASK, attempt: SETTLE_RESET },
  lastBlockTriage: { merge: PER_TASK, attempt: SETTLE_RESET },
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
  // Re-seeded by start-attempt AFTER the reset when the attempt is a crash resume.
  crashResumePending: { merge: PER_TASK, attempt: RESET },
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
  // (resetSignalAccumulators).
  currentAttemptDecisions: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptChanges: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptLearnings: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptNotes: { merge: SIGNAL_ACCUM, attempt: CARRY },
  // Corrective-nudge tallies — same per-attempt lifecycle as the signal accumulators above.
  currentAttemptGeneratorNudges: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptEvaluatorNudges: { merge: SIGNAL_ACCUM, attempt: CARRY },
  // Per-attempt cost totals — same per-attempt lifecycle as the tallies above, and for the same
  // reason they are `CARRY` on the attempt axis: `settle-attempt` must still READ them (it
  // persists them onto the settling attempt), so only `progress-journal` may clear them.
  currentAttemptInputTokens: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptOutputTokens: { merge: SIGNAL_ACCUM, attempt: CARRY },
  currentAttemptDurationMs: { merge: SIGNAL_ACCUM, attempt: CARRY },
} as const satisfies Record<keyof ImplementCtx, FieldClass>;

type ClassifiedKey = keyof typeof CTX_FIELD_CLASS;
type KeysWhere<A extends keyof FieldClass, C extends FieldClass[A]> = {
  [K in ClassifiedKey]: (typeof CTX_FIELD_CLASS)[K][A] extends C ? K : never;
}[ClassifiedKey];

/** Every field of one class, cleared to `undefined` — derived from the table, so it cannot drift. */
const clearWhere = <A extends keyof FieldClass, C extends FieldClass[A]>(
  axis: A,
  cls: C
): Readonly<Required<Pick<ImplementCtx, KeysWhere<A, C>>>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(CTX_FIELD_CLASS)
        .filter(([, c]) => c[axis] === cls)
        .map(([key]) => [key, undefined])
    )
  ) as Readonly<Required<Pick<ImplementCtx, KeysWhere<A, C>>>>;

/**
 * The run-scoped slice `mergeImplementWave` and `forkCtx` both carry from `base`. The
 * `Required<Pick<…>>` return type forces every `sprint`-classified field to be listed here.
 */
export const projectSprintScopedFields = (
  ctx: ImplementCtx
): Required<Pick<ImplementCtx, KeysWhere<'merge', typeof SPRINT>>> => ({
  sprintId: ctx.sprintId,
  sprint: ctx.sprint,
  execution: ctx.execution,
  progressFile: ctx.progressFile,
  setupVerifiedRepoIdsThisRun: ctx.setupVerifiedRepoIdsThisRun,
  setupTreeRecords: ctx.setupTreeRecords,
  priorLearnings: ctx.priorLearnings,
});

/** Spread by `start-attempt` so an attempt never inherits the prior attempt's scratch. */
export const resetAttemptScratch = clearWhere('attempt', RESET);

/** Spread by `settle-attempt` once the attempt has settled. */
export const resetSettleScratch = clearWhere('attempt', SETTLE_RESET);

/** Spread by `progress-journal` after it renders the attempt's accumulated signals. */
export const resetSignalAccumulators = clearWhere('merge', SIGNAL_ACCUM);
