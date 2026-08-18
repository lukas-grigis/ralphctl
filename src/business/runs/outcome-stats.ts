import type { AbortCause, Attempt, AttemptWarning, Attribution, PlateauSource } from '@src/domain/entity/attempt.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { CriteriaVerdicts, DoneTask, Task, TaskStatus, VerificationCriterion } from '@src/domain/entity/task.ts';

/**
 * Harness outcome rollup — a pure, read-only fold over data the harness ALREADY persists per
 * sprint (`sprint.json` + `tasks.json`, which carries the attempt history). No AI call, no
 * network, no filesystem: the caller loads the aggregates, this module folds them.
 *
 * It answers the four questions a harness post-mortem actually needs:
 *   - how did tasks END (done / done-with-warning / blocked / still open),
 *   - how much did they COST (first-pass rate, attempts-to-done, plateau rate by detector),
 *   - which escalation rung RESOLVED the stall vs fell through, and which rubric dimensions /
 *     acceptance criteria keep failing,
 *   - which attempts BROKE a green baseline, and how the rest of them failed (warning kind,
 *     abort cause) — the taxonomy the task-level counters collapse.
 *
 * ## Scoping
 *
 * The fold does no scoping and no filtering. "One sprint", "a project's sprints", "everything"
 * are all expressed by WHAT the caller passes in {@link foldOutcomeStats}. `totals` is a rollup
 * over every task in every slice; `bySprint` keeps the per-sprint breakdown in input order. A
 * caller that passes the same sprint twice gets it counted twice — de-duplication is a caller
 * concern.
 *
 * ## Tolerant reader
 *
 * Every read is defensive. The type signatures describe the CURRENT entity shape, but the input
 * is rehydrated from on-disk records that may predate any given field (`Attempt.warning.source`,
 * `Task.criteriaVerdicts`, `DoneTask.finalAttemptN`, the escalation stamps …). A legacy or
 * partial record contributes to the metrics it CAN and is skipped for the rest — it never throws
 * and never poisons a count with `NaN`. Throws are reserved for programmer errors; this fold is
 * total, so it has none and needs no `Result` envelope.
 *
 * Pure. No I/O, no clock, no randomness — same input, same output.
 */

/**
 * One loaded sprint aggregate: the planning entity plus the tasks persisted beside it. Mirrors
 * the on-disk split (`sprint.json` / `tasks.json`) rather than inventing a parallel shape.
 */
export interface SprintWithTasks {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
}

/**
 * Which plateau detector fired, widened with the slot legacy records land in. `unspecified`
 * covers every `plateau` warning persisted before {@link PlateauSource} existed — those attempts
 * still count towards the plateau rate, they just can't be attributed to a detector.
 */
export type PlateauSourceKey = PlateauSource | 'unspecified';

/**
 * An {@link Attribution} verdict, widened with the slot attempts land in when no verdict was
 * derivable — a pre-verify spawn-error, a repository with no verify script, or a record persisted
 * before the field existed. `unspecified` is an ABSENCE of evidence, not a clean bill of health,
 * which is why it never counts towards {@link AttributionStats.regressionRate}'s denominator.
 */
export type AttributionKey = Attribution | 'unspecified';

/**
 * An {@link AttemptWarning} discriminant, widened with the slot an unrecognised historical kind
 * lands in. A warning shape this build has never heard of still counts as "the attempt warned".
 */
export type WarningKindKey = AttemptWarning['kind'] | 'unknown';

/**
 * Why an aborted attempt died. No widened alias: {@link AbortCause} already carries `unknown` as
 * its documented legacy/absent fallback, and a second bucket meaning the same thing would just
 * split the count.
 */
export type AbortCauseKey = AbortCause;

/**
 * The harness's most severe quality signal: did an attempt break a GREEN baseline? Derived from
 * the per-attempt attribution verdict the post-verify leaf stamps from the pre/post verify pair.
 *
 * `attributed` is the honest denominator — most attempts in a repo with no verify script carry no
 * verdict at all, so rating regressions over every attempt would silently under-report. Those
 * attempts stay visible as `byVerdict.unspecified`.
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
 * A rung of the escalation ladder, as reconstructable from the DURABLE task stamps:
 *
 *  - `model`            — `escalatedFromModel` / `escalatedToModel` differ (a model bump).
 *  - `effort`           — `escalatedToEffort` is stamped (same-model generator effort rung).
 *  - `evaluator-effort` — `escalatedToEvaluatorEffort` is stamped (evaluator-side effort rung).
 *  - `nudge`            — the model pair is stamped and EQUAL (top-of-ladder same-model nudge).
 *  - `best-of-n`        — the permanent `bestOfNGranted` marker is set.
 *
 * Known limitation, stated so readers don't over-trust the number: the model pair is re-stamped
 * on every climb, so a task that bumped models twice and was then nudged reports `nudge` only.
 * The counts are therefore "rungs still visible in the final record", which is the strongest
 * claim the persisted data supports.
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

// ───────────────────────── tolerant reads ─────────────────────────

/** True for a non-null object — the shape guard every legacy-record read starts from. */
const isRecord = (value: unknown): boolean => typeof value === 'object' && value !== null;

/** Trimmed string, or `undefined` when the field is absent / blank / not a string. */
const readString = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** The array, or `[]` when a legacy record omitted it (or stored something that is not one). */
const readArray = <T>(value: readonly T[] | undefined): readonly T[] => (Array.isArray(value) ? value : []);

/** The verdict map, or `{}` when absent — a task graded no criteria yet. */
const readVerdicts = (value: CriteriaVerdicts | undefined): CriteriaVerdicts => (isRecord(value) ? (value ?? {}) : {});

/** `num / den`, with the empty denominator collapsing to `0` instead of `NaN`. */
const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);

// ───────────────────────── taxonomy vocabularies ─────────────────────────

/*
 * Each zero record below is the SINGLE point of exhaustiveness for its taxonomy: the literal is
 * typed `Record<Key, number>`, so widening the underlying domain union stops compiling here until
 * the new member gets a bucket. `bucketKey` then derives the RUNTIME vocabulary from that same
 * record, which is why the two can never drift the way a hand-maintained membership Set can.
 */

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
  unknown: 0,
});

const zeroPlateauSource = (): Record<PlateauSourceKey, number> => ({
  threshold: 0,
  diversity: 0,
  entropy: 0,
  unspecified: 0,
});

/**
 * Tolerant key resolution. Own-key membership on the zero record IS the vocabulary, so an absent,
 * non-string or unrecognised historical value lands in `fallback` instead of inventing a bucket.
 * `Object.hasOwn` rather than `in` — a persisted `'constructor'` must not match the prototype.
 */
const bucketKey = <K extends string>(zero: Readonly<Record<K, number>>, raw: unknown, fallback: NoInfer<K>): K =>
  typeof raw === 'string' && Object.hasOwn(zero, raw) ? (raw as K) : fallback;

// ───────────────────────── accumulator ─────────────────────────

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

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

// ───────────────────────── per-task absorption ─────────────────────────

/** Count the task's lifecycle state. An unrecognised (corrupt) status is skipped, not invented. */
const absorbStatus = (acc: Accumulator, task: Task): void => {
  const status = task.status;
  if (Object.hasOwn(acc.byStatus, status)) acc.byStatus[status] += 1;
};

/**
 * Attempts spent reaching `done`: the stamped `finalAttemptN` when it is a sane 1-indexed
 * pointer, else the attempt-history length. `undefined` for a done task with neither (a legacy
 * record) — it still counts in the outcome mix, just not in the distribution.
 */
const attemptsSpent = (task: DoneTask): number | undefined => {
  const stamped = task.finalAttemptN;
  if (typeof stamped === 'number' && Number.isInteger(stamped) && stamped >= 1) return stamped;
  const length = readArray<Attempt>(task.attempts).length;
  return length >= 1 ? length : undefined;
};

const absorbDone = (acc: Accumulator, task: DoneTask): void => {
  acc.doneTotal += 1;
  if (readArray<Attempt>(task.attempts).at(-1)?.warning !== undefined) acc.doneWithWarning += 1;
  const spent = attemptsSpent(task);
  if (spent === undefined) return;
  if (spent === 1) acc.doneOnFirstAttempt += 1;
  acc.attemptsToDone.set(spent, (acc.attemptsToDone.get(spent) ?? 0) + 1);
};

/** Detector split for one plateau warning, plus the failed-dimension histogram it carries. */
const absorbPlateau = (acc: Accumulator, warning: AttemptWarning & { kind: 'plateau' }): void => {
  acc.attemptsWithPlateau += 1;
  acc.bySource[bucketKey(acc.bySource, warning.source, 'unspecified')] += 1;
  for (const raw of readArray<string>(warning.dimensions)) {
    const name = readString(raw)?.toLowerCase();
    if (name !== undefined) bump(acc.dimensions, name);
  }
};

/**
 * Fold the attempt history in one pass: the attempt-based denominator, the attribution verdict,
 * the warning taxonomy (plateau incidence by detector plus the failed-dimension histogram), and
 * the abort-cause split.
 *
 * The dimension histogram is built from `plateau` warnings because their `dimensions` array is the
 * ONLY durable record of which rubric axes failed — `Attempt.evaluation` deliberately persists just
 * a status plus the verdict-file path (the prose body was an OOM source). Names are lowercased,
 * matching the normalisation the plateau predicate applies before stamping, and cover the floor
 * rubric plus any planner-authored extra dimension; the canonical floor list itself lives in the
 * integration layer and is (correctly) out of reach from here.
 *
 * `regressed` is counted per attempt AND per task: a task that regressed twice is one broken
 * baseline for incidence purposes but two bad attempts for rate purposes.
 */
const absorbAttempts = (acc: Accumulator, task: Task): void => {
  let plateaued = false;
  let regressed = false;
  for (const attempt of readArray<Attempt>(task.attempts)) {
    if (!isRecord(attempt)) continue;
    acc.attemptCount += 1;

    const verdict = bucketKey(acc.byVerdict, attempt.attribution, 'unspecified');
    acc.byVerdict[verdict] += 1;
    if (verdict === 'regressed') regressed = true;

    const warning = attempt.warning;
    if (warning !== undefined && isRecord(warning)) {
      acc.attemptsWithWarning += 1;
      acc.byWarningKind[bucketKey(acc.byWarningKind, warning.kind, 'unknown')] += 1;
      if (warning.kind === 'plateau') {
        plateaued = true;
        absorbPlateau(acc, warning);
      }
    }

    // Gated on the status, not the field: a stale cause on a settled attempt is not an abort.
    if (attempt.status === 'aborted') {
      acc.attemptsAborted += 1;
      acc.byAbortCause[bucketKey(acc.byAbortCause, attempt.abortCause, 'unknown')] += 1;
    }
  }
  if (plateaued) acc.tasksWithPlateau += 1;
  if (regressed) acc.tasksWithRegression += 1;
};

/** Rungs still visible in the task's final record. See {@link EscalationRung} for the caveat. */
const rungsGranted = (task: Task): readonly EscalationRung[] => {
  const rungs: EscalationRung[] = [];
  const from = readString(task.escalatedFromModel);
  const to = readString(task.escalatedToModel);
  if (to !== undefined) rungs.push(from === to ? 'nudge' : 'model');
  if (readString(task.escalatedToEffort) !== undefined) rungs.push('effort');
  if (readString(task.escalatedToEvaluatorEffort) !== undefined) rungs.push('evaluator-effort');
  if (task.bestOfNGranted === true) rungs.push('best-of-n');
  return rungs;
};

const rungOutcome = (task: Task): RungOutcome => {
  if (task.status === 'done') return 'resolved';
  return task.status === 'blocked' ? 'fellThrough' : 'unsettled';
};

const absorbEscalation = (acc: Accumulator, task: Task): void => {
  const outcome = rungOutcome(task);
  for (const rung of rungsGranted(task)) {
    const efficacy = acc.escalation[rung];
    efficacy.granted += 1;
    efficacy[outcome] += 1;
  }
};

/**
 * The criteria universe for one task: its declared checklist ids, de-duplicated. A legacy task
 * whose checklist is missing but which carries verdicts falls back to the verdict map's own keys
 * so its k/N is not silently dropped.
 */
const criterionIds = (task: Task, verdicts: CriteriaVerdicts): readonly string[] => {
  const declared = readArray<VerificationCriterion>(task.verificationCriteria)
    .map((criterion) => readString(criterion?.id))
    .filter((id): id is string => id !== undefined);
  return declared.length > 0 ? [...new Set(declared)] : Object.keys(verdicts);
};

const absorbCriteria = (acc: Accumulator, task: Task): void => {
  const verdicts = readVerdicts(task.criteriaVerdicts);
  if (Object.keys(verdicts).length > 0) acc.criteria.tasksWithVerdicts += 1;
  for (const id of criterionIds(task, verdicts)) {
    acc.criteria.declared += 1;
    const verdict = verdicts[id];
    if (verdict === 'passed') acc.criteria.passed += 1;
    else if (verdict === 'failed') acc.criteria.failed += 1;
    else acc.criteria.unknown += 1;
  }
};

// ───────────────────────── fold ─────────────────────────

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
  criteria: {
    tasksWithVerdicts: acc.criteria.tasksWithVerdicts,
    declared: acc.criteria.declared,
    passed: acc.criteria.passed,
    failed: acc.criteria.failed,
    unknown: acc.criteria.unknown,
    passRate: ratio(acc.criteria.passed, acc.criteria.declared),
  },
});

/**
 * Fold ONE loose task list — the sprint-less entry point. {@link foldOutcomeStats} is this
 * function plus sprint identity and the per-sprint breakdown; the TUI's baseline-health synthesis
 * consumes it directly so its attribution counts and `ralphctl runs stats` cannot disagree.
 *
 * Same tolerance guarantees as the sprint-level fold: a legacy task with no `attempts` array, a
 * null row, or an unrecognised enum value contributes what it can and never throws.
 *
 * @public
 */
export const foldTaskRollup = (tasks: readonly Task[]): OutcomeRollup => {
  const acc = emptyAccumulator();
  for (const task of readArray<Task>(tasks)) {
    if (!isRecord(task)) continue;
    acc.taskCount += 1;
    absorbStatus(acc, task);
    if (task.status === 'done') absorbDone(acc, task);
    absorbAttempts(acc, task);
    absorbEscalation(acc, task);
    absorbCriteria(acc, task);
  }
  return finalize(acc);
};

const sprintRollup = (slice: SprintWithTasks): SprintOutcomeRollup => ({
  sprintId: readString(slice.sprint?.id) ?? '',
  sprintName: readString(slice.sprint?.name) ?? '',
  rollup: foldTaskRollup(readArray<Task>(slice.tasks)),
});

/**
 * Fold the loaded sprint aggregates into the outcome rollup. Empty input yields a well-formed
 * all-zero report (every rate `0`, every histogram empty) rather than a special case the caller
 * has to branch on.
 */
export const foldOutcomeStats = (sprints: readonly SprintWithTasks[]): OutcomeStats => {
  const slices = readArray<SprintWithTasks>(sprints).filter((slice) => isRecord(slice));
  return {
    sprintCount: slices.length,
    totals: foldTaskRollup(slices.flatMap((slice) => readArray<Task>(slice.tasks))),
    bySprint: slices.map(sprintRollup),
  };
};
