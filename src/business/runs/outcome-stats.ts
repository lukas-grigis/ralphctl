import type { Attempt, PlateauSource } from '@src/domain/entity/attempt.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { CriteriaVerdicts, DoneTask, Task, TaskStatus, VerificationCriterion } from '@src/domain/entity/task.ts';

/**
 * Harness outcome rollup — a pure, read-only fold over data the harness ALREADY persists per
 * sprint (`sprint.json` + `tasks.json`, which carries the attempt history). No AI call, no
 * network, no filesystem: the caller loads the aggregates, this module folds them.
 *
 * It answers the three questions a harness post-mortem actually needs:
 *   - how did tasks END (done / done-with-warning / blocked / still open),
 *   - how much did they COST (first-pass rate, attempts-to-done, plateau rate by detector),
 *   - which escalation rung RESOLVED the stall vs fell through, and which rubric dimensions /
 *     acceptance criteria keep failing.
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

/** The metric set folded over one set of tasks. */
export interface OutcomeRollup {
  readonly taskCount: number;
  readonly outcomes: OutcomeMix;
  readonly firstPass: FirstPassStats;
  readonly attemptsToDone: readonly AttemptsToDoneBucket[];
  readonly plateau: PlateauStats;
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
  readonly byStatus: Record<TaskStatus, number>;
  doneTotal: number;
  doneWithWarning: number;
  doneOnFirstAttempt: number;
  readonly attemptsToDone: Map<number, number>;
  tasksWithPlateau: number;
  attemptsWithPlateau: number;
  readonly bySource: Record<PlateauSourceKey, number>;
  readonly escalation: Record<EscalationRung, MutableEfficacy>;
  readonly dimensions: Map<string, number>;
  readonly criteria: { tasksWithVerdicts: number; declared: number; passed: number; failed: number; unknown: number };
}

const emptyEfficacy = (): MutableEfficacy => ({ granted: 0, resolved: 0, fellThrough: 0, unsettled: 0 });

const emptyAccumulator = (): Accumulator => ({
  taskCount: 0,
  byStatus: { todo: 0, in_progress: 0, done: 0, blocked: 0 },
  doneTotal: 0,
  doneWithWarning: 0,
  doneOnFirstAttempt: 0,
  attemptsToDone: new Map(),
  tasksWithPlateau: 0,
  attemptsWithPlateau: 0,
  bySource: { threshold: 0, diversity: 0, entropy: 0, unspecified: 0 },
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

const PLATEAU_SOURCES: ReadonlySet<string> = new Set<PlateauSource>(['threshold', 'diversity', 'entropy']);

const plateauSourceKey = (source: PlateauSource | undefined): PlateauSourceKey =>
  typeof source === 'string' && PLATEAU_SOURCES.has(source) ? source : 'unspecified';

/**
 * Fold the attempt history: plateau incidence by detector, and the failed-dimension histogram.
 *
 * The histogram is built from `plateau` warnings because their `dimensions` array is the ONLY
 * durable record of which rubric axes failed — `Attempt.evaluation` deliberately persists just a
 * status plus the verdict-file path (the prose body was an OOM source). Names are lowercased,
 * matching the normalisation the plateau predicate applies before stamping, and cover the floor
 * rubric plus any planner-authored extra dimension; the canonical floor list itself lives in the
 * integration layer and is (correctly) out of reach from here.
 */
const absorbAttempts = (acc: Accumulator, task: Task): void => {
  let plateaued = false;
  for (const attempt of readArray<Attempt>(task.attempts)) {
    const warning = attempt?.warning;
    if (warning === undefined || warning.kind !== 'plateau') continue;
    plateaued = true;
    acc.attemptsWithPlateau += 1;
    acc.bySource[plateauSourceKey(warning.source)] += 1;
    for (const raw of readArray<string>(warning.dimensions)) {
      const name = readString(raw)?.toLowerCase();
      if (name !== undefined) bump(acc.dimensions, name);
    }
  }
  if (plateaued) acc.tasksWithPlateau += 1;
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

const rollupTasks = (tasks: readonly Task[]): OutcomeRollup => {
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
  rollup: rollupTasks(readArray<Task>(slice.tasks)),
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
    totals: rollupTasks(slices.flatMap((slice) => readArray<Task>(slice.tasks))),
    bySprint: slices.map(sprintRollup),
  };
};
