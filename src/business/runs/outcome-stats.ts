import type { AbortCause, Attempt, AttemptWarning, Attribution, PlateauSource } from '@src/domain/entity/attempt.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { CriteriaVerdicts, DoneTask, RetiredRun, Task, TaskStatus } from '@src/domain/entity/task.ts';

/**
 * Harness outcome rollup — a pure fold over what the harness already persists per sprint
 * (`sprint.json` + `tasks.json` with its attempt history): how tasks ended, what they cost, which
 * escalation rung resolved them, which dimensions / criteria keep failing, and which attempts broke
 * a green baseline.
 *
 * No scoping or de-duplication: `totals` rolls up every task passed in, `bySprint` keeps the
 * per-sprint breakdown in input order. Input is schema-validated; optional fields fall into
 * `unspecified` / `unknown` buckets.
 */

/** One loaded sprint aggregate, mirroring the on-disk `sprint.json` / `tasks.json` split. */
export interface SprintWithTasks {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
}

/** `unspecified`: a plateau warning persisted before {@link PlateauSource} existed. */
export type PlateauSourceKey = PlateauSource | 'unspecified';

/**
 * `unspecified`: no verdict was derivable (pre-verify spawn-error, no verify script, legacy record).
 * An absence of evidence, so it never counts towards the regression-rate denominator.
 */
export type AttributionKey = Attribution | 'unspecified';

/** `unknown` stays in the vocabulary (always `0` today) so the `runs stats --json` shape is stable. */
export type WarningKindKey = AttemptWarning['kind'] | 'unknown';

export type AbortCauseKey = AbortCause;

/**
 * Did an attempt break a GREEN baseline? `attributed` is the honest denominator: attempts in a repo
 * with no verify script carry no verdict, and rating over them would under-report.
 */
export interface AttributionStats {
  /** Attempts carrying a real verdict: `attemptCount` minus `byVerdict.unspecified`. */
  readonly attributed: number;
  readonly byVerdict: Readonly<Record<AttributionKey, number>>;
  /** `regressed / attributed`, `0` when nothing is attributed (never `NaN`). */
  readonly regressionRate: number;
  /** A task counts once here however many of its attempts regressed. */
  readonly tasksWithRegression: number;
}

/**
 * Every attempt-terminating warning, split by kind — the taxonomy {@link OutcomeMix.doneWithWarning}
 * collapses into a single done-task scalar. Counts EVERY attempt's warning, including the ones on
 * intermediate attempts of a task that eventually landed clean.
 */
export interface WarningStats {
  readonly attemptsWithWarning: number;
  readonly byKind: Readonly<Record<WarningKindKey, number>>;
}

/**
 * Why aborted attempts died. Counted only for attempts whose `status` is `aborted`, so a stale
 * cause riding a settled attempt cannot inflate the total.
 */
export interface AbortStats {
  readonly attemptsAborted: number;
  readonly byCause: Readonly<Record<AbortCauseKey, number>>;
}

/**
 * A rung reconstructed from the durable task stamps (live task and every retired run): `model` /
 * `nudge` when the model pair differs / is equal, `effort` / `evaluator-effort` when stamped,
 * `best-of-n` from the permanent marker. The model pair is re-stamped on every climb, so a task
 * that bumped twice and was then nudged reports `nudge` only — "rungs still visible in the record".
 */
export type EscalationRung = 'model' | 'effort' | 'evaluator-effort' | 'nudge' | 'best-of-n';

/**
 * Did the task settle after the rung fired? `resolved` — reached `done` (with or without a
 * warning); `fellThrough` — ended `blocked`; `unsettled` — still open (`todo` / `in_progress`),
 * so the rung has no verdict yet.
 */
export interface RungEfficacy {
  readonly granted: number;
  readonly resolved: number;
  readonly fellThrough: number;
  readonly unsettled: number;
}

/**
 * Terminal + open state mix. `byStatus` enumerates the whole {@link TaskStatus} union, so a new
 * task state fails to compile here rather than silently vanishing from the report.
 */
export interface OutcomeMix {
  readonly byStatus: Readonly<Record<TaskStatus, number>>;
  /** Done tasks whose final attempt carries NO warning. */
  readonly doneClean: number;
  /** Done tasks whose final attempt carries a warning (budget / plateau / malformed / verify). */
  readonly doneWithWarning: number;
}

/** Done-on-the-first-attempt share. `rate` is `0` when nothing is done yet (never `NaN`). */
export interface FirstPassStats {
  readonly doneOnFirstAttempt: number;
  readonly doneTotal: number;
  readonly rate: number;
}

/** One bucket of the attempts-to-done distribution, ascending by `attempts`. */
export interface AttemptsToDoneBucket {
  readonly attempts: number;
  readonly tasks: number;
}

/**
 * Plateau incidence. `tasksWithPlateau` / `taskRate` count a task once however many of its
 * attempts plateaued; `attemptsWithPlateau` and `bySource` count every plateau warning.
 */
export interface PlateauStats {
  readonly tasksWithPlateau: number;
  readonly taskRate: number;
  readonly attemptsWithPlateau: number;
  readonly bySource: Readonly<Record<PlateauSourceKey, number>>;
}

/** How often a rubric dimension appeared in a plateau's failed-dimension set. */
export interface DimensionFailureCount {
  readonly dimension: string;
  readonly count: number;
}

/**
 * k-of-N over the durable per-criterion verdict map. `declared` is N (the criteria checklist),
 * `passed` is k. Criteria with no recorded verdict count as `unknown`, never as failures.
 */
export interface CriteriaRollup {
  readonly tasksWithVerdicts: number;
  readonly declared: number;
  readonly passed: number;
  readonly failed: number;
  readonly unknown: number;
  readonly passRate: number;
}

/**
 * The metric set folded over one set of tasks. Two denominators coexist here and are NOT
 * comparable: `taskCount` backs the outcome mix / first-pass / plateau-task rates, `attemptCount`
 * backs the attribution / warning / abort taxonomy. Every presentation of these numbers has to
 * label which one it is quoting.
 */
export interface OutcomeRollup {
  readonly taskCount: number;
  /** Every attempt across every task, including one still `running`. */
  readonly attemptCount: number;
  readonly outcomes: OutcomeMix;
  readonly firstPass: FirstPassStats;
  readonly attemptsToDone: readonly AttemptsToDoneBucket[];
  readonly plateau: PlateauStats;
  readonly attribution: AttributionStats;
  readonly warnings: WarningStats;
  readonly aborts: AbortStats;
  readonly escalation: Readonly<Record<EscalationRung, RungEfficacy>>;
  readonly failedDimensions: readonly DimensionFailureCount[];
  readonly criteria: CriteriaRollup;
}

/** Per-sprint breakdown entry. Identity only — no lifecycle state, that is not a metric. */
export interface SprintOutcomeRollup {
  readonly sprintId: string;
  readonly sprintName: string;
  readonly rollup: OutcomeRollup;
}

/** Totals plus the per-sprint breakdown, in input order. */
export interface OutcomeStats {
  readonly sprintCount: number;
  readonly totals: OutcomeRollup;
  readonly bySprint: readonly SprintOutcomeRollup[];
}

/** `num / den`, with the empty denominator collapsing to `0` instead of `NaN`. */
const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);

/** Trimmed string, or `undefined` when absent or blank. */
const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const retiredRuns = (task: Task): readonly RetiredRun[] => task.retiredAttempts ?? [];

/**
 * The live attempts plus every retired run's archive. `unblockTask` moves cleared attempts into
 * `retiredAttempts`, so folding both keeps their signal counted after an operator intervenes.
 */
const allAttempts = (task: Task): readonly Attempt[] => [
  ...task.attempts,
  ...retiredRuns(task).flatMap((run) => run.attempts),
];

// Each zero record is typed `Record<Key, number>`, so widening a domain union stops compiling here
// until the new member gets a bucket.

const zeroAttribution = (): Record<AttributionKey, number> => ({
  clean: 0,
  regressed: 0,
  'baseline-broken': 0,
  'fixed-baseline': 0,
  unspecified: 0,
});

const zeroWarningKind = (): Record<WarningKindKey, number> => ({
  'budget-exhausted': 0,
  plateau: 0,
  malformed: 0,
  'verify-failed': 0,
  crashed: 0,
  unknown: 0,
});

const zeroAbortCause = (): Record<AbortCauseKey, number> => ({
  'user-cancel': 0,
  sigterm: 0,
  'watchdog-killed': 0,
  'rate-limit-exhausted': 0,
  'process-crash': 0,
  'harness-interrupted': 0,
  'self-blocked': 0,
  unknown: 0,
});

const zeroPlateauSource = (): Record<PlateauSourceKey, number> => ({
  threshold: 0,
  diversity: 0,
  entropy: 0,
  unspecified: 0,
});

type RungOutcome = 'resolved' | 'fellThrough' | 'unsettled';

interface MutableEfficacy {
  granted: number;
  resolved: number;
  fellThrough: number;
  unsettled: number;
}

interface Accumulator {
  taskCount: number;
  attemptCount: number;
  readonly byStatus: Record<TaskStatus, number>;
  doneTotal: number;
  doneWithWarning: number;
  doneOnFirstAttempt: number;
  readonly attemptsToDone: Map<number, number>;
  tasksWithPlateau: number;
  attemptsWithPlateau: number;
  readonly bySource: Record<PlateauSourceKey, number>;
  readonly byVerdict: Record<AttributionKey, number>;
  tasksWithRegression: number;
  attemptsWithWarning: number;
  readonly byWarningKind: Record<WarningKindKey, number>;
  attemptsAborted: number;
  readonly byAbortCause: Record<AbortCauseKey, number>;
  readonly escalation: Record<EscalationRung, MutableEfficacy>;
  readonly dimensions: Map<string, number>;
  readonly criteria: { tasksWithVerdicts: number; declared: number; passed: number; failed: number; unknown: number };
}

const emptyEfficacy = (): MutableEfficacy => ({ granted: 0, resolved: 0, fellThrough: 0, unsettled: 0 });

const emptyAccumulator = (): Accumulator => ({
  taskCount: 0,
  attemptCount: 0,
  byStatus: { todo: 0, in_progress: 0, done: 0, blocked: 0 },
  doneTotal: 0,
  doneWithWarning: 0,
  doneOnFirstAttempt: 0,
  attemptsToDone: new Map(),
  tasksWithPlateau: 0,
  attemptsWithPlateau: 0,
  bySource: zeroPlateauSource(),
  byVerdict: zeroAttribution(),
  tasksWithRegression: 0,
  attemptsWithWarning: 0,
  byWarningKind: zeroWarningKind(),
  attemptsAborted: 0,
  byAbortCause: zeroAbortCause(),
  escalation: {
    model: emptyEfficacy(),
    effort: emptyEfficacy(),
    'evaluator-effort': emptyEfficacy(),
    nudge: emptyEfficacy(),
    'best-of-n': emptyEfficacy(),
  },
  dimensions: new Map(),
  criteria: { tasksWithVerdicts: 0, declared: 0, passed: 0, failed: 0, unknown: 0 },
});

const bump = <K>(counts: Map<K, number>, key: K): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/**
 * Attempts spent reaching `done`: `finalAttemptN` plus every archived run's attempts. `unblockTask`
 * resets the live ledger, so a task that passed right after an unblock would otherwise read as first-pass.
 */
const attemptsSpent = (task: DoneTask): number =>
  task.finalAttemptN + retiredRuns(task).reduce((sum, run) => sum + run.attempts.length, 0);

const absorbDone = (acc: Accumulator, task: DoneTask): void => {
  acc.doneTotal += 1;
  if (task.attempts.at(-1)?.warning !== undefined) acc.doneWithWarning += 1;
  const spent = attemptsSpent(task);
  if (spent === 1) acc.doneOnFirstAttempt += 1;
  bump(acc.attemptsToDone, spent);
};

/**
 * Plateau warnings carry the ONLY durable record of which rubric axes failed (`Attempt.evaluation`
 * keeps just a status and a file path), so the dimension histogram is built from them. Names are
 * lowercased to match the plateau predicate's normalisation.
 */
const absorbPlateau = (acc: Accumulator, warning: AttemptWarning & { kind: 'plateau' }): void => {
  acc.attemptsWithPlateau += 1;
  acc.bySource[warning.source ?? 'unspecified'] += 1;
  for (const raw of warning.dimensions) {
    const name = nonBlank(raw)?.toLowerCase();
    if (name !== undefined) bump(acc.dimensions, name);
  }
};

/** `regressed` counts per attempt (rate) AND per task (incidence). */
const absorbAttempts = (acc: Accumulator, task: Task): void => {
  let plateaued = false;
  let regressed = false;
  for (const attempt of allAttempts(task)) {
    acc.attemptCount += 1;

    const verdict = attempt.attribution ?? 'unspecified';
    acc.byVerdict[verdict] += 1;
    if (verdict === 'regressed') regressed = true;

    const warning = attempt.warning;
    if (warning !== undefined) {
      acc.attemptsWithWarning += 1;
      acc.byWarningKind[warning.kind] += 1;
      if (warning.kind === 'plateau') {
        plateaued = true;
        absorbPlateau(acc, warning);
      }
    }

    // Gated on the status, not the field: a stale cause on a settled attempt is not an abort.
    if (attempt.status === 'aborted') {
      acc.attemptsAborted += 1;
      acc.byAbortCause[attempt.abortCause ?? 'unknown'] += 1;
    }
  }
  if (plateaued) acc.tasksWithPlateau += 1;
  if (regressed) acc.tasksWithRegression += 1;
};

/** The four re-stampable rungs a live task and each archived {@link RetiredRun} both carry. */
type EscalationStamps = Pick<
  RetiredRun,
  'escalatedFromModel' | 'escalatedToModel' | 'escalatedToEffort' | 'escalatedToEvaluatorEffort'
>;

const rungsFromStamps = (stamps: EscalationStamps): readonly EscalationRung[] => {
  const rungs: EscalationRung[] = [];
  const from = nonBlank(stamps.escalatedFromModel);
  const to = nonBlank(stamps.escalatedToModel);
  if (to !== undefined) rungs.push(from === to ? 'nudge' : 'model');
  if (nonBlank(stamps.escalatedToEffort) !== undefined) rungs.push('effort');
  if (nonBlank(stamps.escalatedToEvaluatorEffort) !== undefined) rungs.push('evaluator-effort');
  return rungs;
};

/** `best-of-n`'s marker is permanent and stays live across an unblock, so it is counted once here. */
const rungsGranted = (task: Task): readonly EscalationRung[] => [
  ...rungsFromStamps(task),
  ...(task.bestOfNGranted === true ? (['best-of-n'] as const) : []),
];

const rungOutcome = (task: Task): RungOutcome => {
  if (task.status === 'done') return 'resolved';
  return task.status === 'blocked' ? 'fellThrough' : 'unsettled';
};

/**
 * Live stamps count under the task's current outcome; every retired run's stamps under
 * `fellThrough`, since only `unblockTask` retires a run and it runs on a task that ended `blocked`.
 */
const absorbEscalation = (acc: Accumulator, task: Task): void => {
  const outcome = rungOutcome(task);
  for (const rung of rungsGranted(task)) {
    const efficacy = acc.escalation[rung];
    efficacy.granted += 1;
    efficacy[outcome] += 1;
  }
  for (const rung of retiredRuns(task).flatMap(rungsFromStamps)) {
    const efficacy = acc.escalation[rung];
    efficacy.granted += 1;
    efficacy.fellThrough += 1;
  }
};

/** Declared checklist ids, de-duplicated; a task with verdicts but no checklist falls back to the verdict keys. */
const criterionIds = (task: Task, verdicts: CriteriaVerdicts): readonly string[] => {
  const declared = (task.verificationCriteria ?? [])
    .map((criterion) => nonBlank(criterion.id))
    .filter((id): id is string => id !== undefined);
  return declared.length > 0 ? [...new Set(declared)] : Object.keys(verdicts);
};

const absorbCriteria = (acc: Accumulator, task: Task): void => {
  const verdicts = task.criteriaVerdicts ?? {};
  if (Object.keys(verdicts).length > 0) acc.criteria.tasksWithVerdicts += 1;
  for (const id of criterionIds(task, verdicts)) {
    acc.criteria.declared += 1;
    const verdict = verdicts[id];
    if (verdict === 'passed') acc.criteria.passed += 1;
    else if (verdict === 'failed') acc.criteria.failed += 1;
    else acc.criteria.unknown += 1;
  }
};

const byCountThenName = (a: DimensionFailureCount, b: DimensionFailureCount): number =>
  b.count - a.count || a.dimension.localeCompare(b.dimension);

const finalize = (acc: Accumulator): OutcomeRollup => ({
  taskCount: acc.taskCount,
  attemptCount: acc.attemptCount,
  outcomes: {
    byStatus: acc.byStatus,
    doneClean: acc.doneTotal - acc.doneWithWarning,
    doneWithWarning: acc.doneWithWarning,
  },
  firstPass: {
    doneOnFirstAttempt: acc.doneOnFirstAttempt,
    doneTotal: acc.doneTotal,
    rate: ratio(acc.doneOnFirstAttempt, acc.doneTotal),
  },
  attemptsToDone: [...acc.attemptsToDone.entries()]
    .map(([attempts, tasks]) => ({ attempts, tasks }))
    .sort((a, b) => a.attempts - b.attempts),
  plateau: {
    tasksWithPlateau: acc.tasksWithPlateau,
    taskRate: ratio(acc.tasksWithPlateau, acc.taskCount),
    attemptsWithPlateau: acc.attemptsWithPlateau,
    bySource: acc.bySource,
  },
  attribution: {
    attributed: acc.attemptCount - acc.byVerdict.unspecified,
    byVerdict: acc.byVerdict,
    regressionRate: ratio(acc.byVerdict.regressed, acc.attemptCount - acc.byVerdict.unspecified),
    tasksWithRegression: acc.tasksWithRegression,
  },
  warnings: {
    attemptsWithWarning: acc.attemptsWithWarning,
    byKind: acc.byWarningKind,
  },
  aborts: {
    attemptsAborted: acc.attemptsAborted,
    byCause: acc.byAbortCause,
  },
  escalation: acc.escalation,
  failedDimensions: [...acc.dimensions.entries()]
    .map(([dimension, count]) => ({ dimension, count }))
    .sort(byCountThenName),
  criteria: { ...acc.criteria, passRate: ratio(acc.criteria.passed, acc.criteria.declared) },
});

/**
 * Fold one loose task list. {@link foldOutcomeStats} is this plus sprint identity; the TUI's
 * baseline-health card consumes it directly so it and `ralphctl runs stats` cannot disagree.
 */
export const foldTaskRollup = (tasks: readonly Task[]): OutcomeRollup => {
  const acc = emptyAccumulator();
  for (const task of tasks) {
    acc.taskCount += 1;
    acc.byStatus[task.status] += 1;
    if (task.status === 'done') absorbDone(acc, task);
    absorbAttempts(acc, task);
    absorbEscalation(acc, task);
    absorbCriteria(acc, task);
  }
  return finalize(acc);
};

const sprintRollup = (slice: SprintWithTasks): SprintOutcomeRollup => ({
  sprintId: slice.sprint.id.trim(),
  sprintName: slice.sprint.name.trim(),
  rollup: foldTaskRollup(slice.tasks),
});

/** Empty input yields a well-formed all-zero report rather than a special case. */
export const foldOutcomeStats = (sprints: readonly SprintWithTasks[]): OutcomeStats => ({
  sprintCount: sprints.length,
  totals: foldTaskRollup(sprints.flatMap((slice) => slice.tasks)),
  bySprint: sprints.map(sprintRollup),
});
