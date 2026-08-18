import { describe, expect, it } from 'vitest';
import type { Result } from '@src/domain/result.ts';
import type { AbortCause, AttemptWarning, Attribution } from '@src/domain/entity/attempt.ts';
import type { DoneTask, InProgressTask, Task } from '@src/domain/entity/task.ts';
import {
  setAttemptAttribution,
  startNextAttempt,
  recordRunningAttemptVerification,
  recordRunningAttemptWarning,
} from '@src/domain/entity/task-attempts.ts';
import { applyCriteriaVerdicts } from '@src/domain/entity/task-criteria.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import {
  failCurrentAttempt,
  markTaskDone,
  recordTaskBestOfNGrant,
  recordTaskEffortEscalation,
  recordTaskEscalation,
  recordTaskEvaluatorEffortEscalation,
} from '@src/domain/entity/task-settle.ts';
import { foldOutcomeStats, foldTaskRollup, type SprintWithTasks } from '@src/business/runs/outcome-stats.ts';
import { FIXED_LATER, FIXED_LATEST, FIXED_NOW, makeActiveSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`fixture unwrap failed: ${JSON.stringify(result.error)}`);
  return result.value as T;
};

const beginAttempt = (task: Task): InProgressTask => unwrap(startNextAttempt(task, FIXED_NOW, 'session-1'));

const withWarning = (task: InProgressTask, warning?: AttemptWarning): InProgressTask =>
  warning === undefined ? task : unwrap(recordRunningAttemptWarning(task, warning));

const failAttempt = (task: InProgressTask, warning?: AttemptWarning): Task =>
  unwrap(failCurrentAttempt(withWarning(task, warning), FIXED_LATER, 'failed'));

const completeDone = (task: InProgressTask, warning?: AttemptWarning): DoneTask =>
  unwrap(markTaskDone(unwrap(recordRunningAttemptVerification(withWarning(task, warning))), FIXED_LATEST));

const withAttribution = (task: InProgressTask, attribution: Attribution): InProgressTask =>
  unwrap(setAttemptAttribution(task, attribution));

const abortAttempt = (task: InProgressTask, abortCause: AbortCause): Task =>
  unwrap(failCurrentAttempt(task, FIXED_LATER, 'aborted', { abortCause }));

const sprintWith = (tasks: readonly Task[]): SprintWithTasks => ({ sprint: makeActiveSprint(), tasks });

const PLATEAU_THRESHOLD: AttemptWarning = {
  kind: 'plateau',
  dimensions: ['Correctness', 'robustness'],
  source: 'threshold',
};
const PLATEAU_DIVERSITY: AttemptWarning = { kind: 'plateau', dimensions: ['correctness'], source: 'diversity' };
const PLATEAU_ENTROPY: AttemptWarning = { kind: 'plateau', dimensions: [], source: 'entropy' };
const BUDGET_WARNING: AttemptWarning = { kind: 'budget-exhausted', turnsUsed: 8, turnBudget: 8 };

/**
 * A three-task sprint mirroring a realistic run:
 *  - `alpha`  — done on the first attempt, no warning.
 *  - `bravo`  — done on the third attempt after two plateaued attempts; final attempt warns.
 *  - `charlie`— plateaued once (entropy detector) and ended blocked on its own merits.
 */
const multiAttemptSprint = (): SprintWithTasks => {
  const alpha = completeDone(beginAttempt(makeTodoTask({ name: 'alpha' })));

  const bravoFirst = failAttempt(beginAttempt(makeTodoTask({ name: 'bravo', maxAttempts: 5 })), PLATEAU_THRESHOLD);
  const bravoSecond = failAttempt(beginAttempt(bravoFirst), PLATEAU_DIVERSITY);
  const bravo = applyCriteriaVerdicts(completeDone(beginAttempt(bravoSecond), BUDGET_WARNING), [
    { id: 'C1', passed: true },
  ]);

  const charlieFailed = failAttempt(beginAttempt(makeTodoTask({ name: 'charlie' })), PLATEAU_ENTROPY);
  const charlie = applyCriteriaVerdicts(unwrap(markTaskBlocked(charlieFailed, 'verification never passed', 'own')), [
    { id: 'C1', passed: false },
  ]);

  return sprintWith([alpha, bravo, charlie]);
};

describe('foldOutcomeStats — empty input', () => {
  it('returns a well-formed all-zero report rather than a special case', () => {
    const stats = foldOutcomeStats([]);

    expect(stats.sprintCount).toBe(0);
    expect(stats.bySprint).toEqual([]);
    expect(stats.totals.taskCount).toBe(0);
    expect(stats.totals.outcomes.byStatus).toEqual({ todo: 0, in_progress: 0, done: 0, blocked: 0 });
    expect(stats.totals.firstPass).toEqual({ doneOnFirstAttempt: 0, doneTotal: 0, rate: 0 });
    expect(stats.totals.attemptsToDone).toEqual([]);
    expect(stats.totals.plateau.taskRate).toBe(0);
    expect(stats.totals.failedDimensions).toEqual([]);
    expect(stats.totals.criteria.passRate).toBe(0);
  });

  it('handles a sprint slice carrying no tasks at all', () => {
    const stats = foldOutcomeStats([sprintWith([])]);

    expect(stats.sprintCount).toBe(1);
    expect(stats.bySprint).toHaveLength(1);
    expect(stats.totals.taskCount).toBe(0);
  });
});

describe('foldOutcomeStats — a happy multi-attempt sprint', () => {
  it('splits the outcome mix into done / done-with-warning / blocked', () => {
    const { totals } = foldOutcomeStats([multiAttemptSprint()]);

    expect(totals.taskCount).toBe(3);
    expect(totals.outcomes.byStatus).toEqual({ todo: 0, in_progress: 0, done: 2, blocked: 1 });
    expect(totals.outcomes.doneClean).toBe(1);
    expect(totals.outcomes.doneWithWarning).toBe(1);
  });

  it('reports the first-pass rate and the attempts-to-done distribution', () => {
    const { totals } = foldOutcomeStats([multiAttemptSprint()]);

    expect(totals.firstPass).toEqual({ doneOnFirstAttempt: 1, doneTotal: 2, rate: 0.5 });
    expect(totals.attemptsToDone).toEqual([
      { attempts: 1, tasks: 1 },
      { attempts: 3, tasks: 1 },
    ]);
  });

  it('splits the plateau rate by detector and counts a task once however many attempts plateaued', () => {
    const { totals } = foldOutcomeStats([multiAttemptSprint()]);

    expect(totals.plateau.tasksWithPlateau).toBe(2);
    expect(totals.plateau.taskRate).toBeCloseTo(2 / 3);
    expect(totals.plateau.attemptsWithPlateau).toBe(3);
    expect(totals.plateau.bySource).toEqual({ threshold: 1, diversity: 1, entropy: 1, unspecified: 0 });
  });

  it('builds the failed-dimension histogram case-insensitively, ordered by count', () => {
    const { totals } = foldOutcomeStats([multiAttemptSprint()]);

    expect(totals.failedDimensions).toEqual([
      { dimension: 'correctness', count: 2 },
      { dimension: 'robustness', count: 1 },
    ]);
  });

  it('rolls the durable criteriaVerdicts map up into a k/N pass rate', () => {
    const { totals } = foldOutcomeStats([multiAttemptSprint()]);

    expect(totals.criteria).toEqual({
      tasksWithVerdicts: 2,
      declared: 3,
      passed: 1,
      failed: 1,
      unknown: 1,
      passRate: 1 / 3,
    });
  });

  it('keeps a per-sprint breakdown alongside the totals, in input order', () => {
    const first = multiAttemptSprint();
    const second = sprintWith([completeDone(beginAttempt(makeTodoTask({ name: 'solo' })))]);

    const stats = foldOutcomeStats([first, second]);

    expect(stats.sprintCount).toBe(2);
    expect(stats.bySprint.map((entry) => entry.sprintId)).toEqual([String(first.sprint.id), String(second.sprint.id)]);
    expect(stats.bySprint.map((entry) => entry.rollup.taskCount)).toEqual([3, 1]);
    expect(stats.totals.taskCount).toBe(4);
    expect(stats.totals.firstPass.doneOnFirstAttempt).toBe(2);
  });
});

describe('foldOutcomeStats — per-rung escalation efficacy', () => {
  const escalationSprint = (): SprintWithTasks => {
    const bumped = unwrap(recordTaskEscalation(beginAttempt(makeTodoTask({ name: 'bumped' })), 'sonnet', 'opus'));
    const bumpedDone = completeDone(bumped);

    const bumpedAgain = unwrap(recordTaskEscalation(beginAttempt(makeTodoTask({ name: 'stuck' })), 'sonnet', 'opus'));
    const bumpedBlocked = unwrap(markTaskBlocked(failAttempt(bumpedAgain), 'still failing', 'own'));

    const nudged = unwrap(recordTaskEscalation(beginAttempt(makeTodoTask({ name: 'nudged' })), 'opus', 'opus'));
    const nudgedBlocked = unwrap(markTaskBlocked(failAttempt(nudged), 'topped out', 'own'));

    const effort = unwrap(recordTaskEffortEscalation(beginAttempt(makeTodoTask({ name: 'effort' })), 'high'));
    const stillRunning = unwrap(recordTaskEvaluatorEffortEscalation(effort, 'high'));

    const granted = unwrap(recordTaskBestOfNGrant(beginAttempt(makeTodoTask({ name: 'best-of-n' })), 3));
    const grantedDone = completeDone(granted);

    return sprintWith([bumpedDone, bumpedBlocked, nudgedBlocked, stillRunning, grantedDone]);
  };

  it('records whether each rung resolved the stall, fell through, or is still unsettled', () => {
    const { totals } = foldOutcomeStats([escalationSprint()]);

    expect(totals.escalation.model).toEqual({ granted: 2, resolved: 1, fellThrough: 1, unsettled: 0 });
    expect(totals.escalation.nudge).toEqual({ granted: 1, resolved: 0, fellThrough: 1, unsettled: 0 });
    expect(totals.escalation.effort).toEqual({ granted: 1, resolved: 0, fellThrough: 0, unsettled: 1 });
    expect(totals.escalation['evaluator-effort']).toEqual({ granted: 1, resolved: 0, fellThrough: 0, unsettled: 1 });
    expect(totals.escalation['best-of-n']).toEqual({ granted: 1, resolved: 1, fellThrough: 0, unsettled: 0 });
  });

  it('leaves every rung at zero for a sprint that never escalated', () => {
    const { totals } = foldOutcomeStats([multiAttemptSprint()]);

    expect(totals.escalation.model.granted).toBe(0);
    expect(totals.escalation.nudge.granted).toBe(0);
    expect(totals.escalation['best-of-n'].granted).toBe(0);
  });

  it('counts a plateau history and a best-of-N grant on the same task', () => {
    const first = failAttempt(beginAttempt(makeTodoTask({ name: 'ladder', maxAttempts: 4 })), PLATEAU_THRESHOLD);
    const secondFailed = failAttempt(beginAttempt(first), PLATEAU_DIVERSITY);
    const granted = unwrap(recordTaskBestOfNGrant(beginAttempt(secondFailed), 2));
    const nudged = unwrap(recordTaskEscalation(granted, 'opus', 'opus'));

    const { totals } = foldOutcomeStats([sprintWith([completeDone(nudged, PLATEAU_ENTROPY)])]);

    expect(totals.plateau.attemptsWithPlateau).toBe(3);
    expect(totals.plateau.bySource).toEqual({ threshold: 1, diversity: 1, entropy: 1, unspecified: 0 });
    expect(totals.escalation.nudge.resolved).toBe(1);
    expect(totals.escalation['best-of-n'].resolved).toBe(1);
    expect(totals.outcomes.doneWithWarning).toBe(1);
  });
});

describe('foldOutcomeStats — legacy and partial records', () => {
  /** Records written before a given field existed. Cast because the type describes today's shape. */
  const legacy = (raw: Record<string, unknown>): Task => raw as unknown as Task;

  const legacySlice = (): SprintWithTasks =>
    sprintWith([
      // Done, but predates `finalAttemptN` AND carries no attempt history at all.
      legacy({ id: 'legacy-done', name: 'legacy done', status: 'done', order: 1 }),
      // Plateau warning predating `PlateauSource`; verdict map without a declared checklist.
      legacy({
        id: 'legacy-plateau',
        name: 'legacy plateau',
        status: 'blocked',
        order: 2,
        attempts: [{ n: 1, status: 'failed', warning: { kind: 'plateau', dimensions: ['Correctness'] } }],
        criteriaVerdicts: { C1: 'passed', C2: 'failed' },
      }),
      // Structurally corrupt: unknown status, non-array collections, blank escalation stamps.
      legacy({
        id: 'corrupt',
        name: 'corrupt',
        status: 'weird',
        attempts: 'not-an-array',
        verificationCriteria: null,
        criteriaVerdicts: 'nope',
        escalatedToModel: '   ',
      }),
      // A null row survived a hand-edited tasks.json.
      legacy(null as unknown as Record<string, unknown>),
    ]);

  it('folds what it can from partial records and skips the rest without throwing', () => {
    const { totals } = foldOutcomeStats([legacySlice()]);

    // The null row is skipped entirely; the other three count.
    expect(totals.taskCount).toBe(3);
    expect(totals.outcomes.byStatus).toEqual({ todo: 0, in_progress: 0, done: 1, blocked: 1 });
  });

  it('keeps a done record with no attempt history out of the distribution but in the mix', () => {
    const { totals } = foldOutcomeStats([legacySlice()]);

    expect(totals.outcomes.doneClean).toBe(1);
    expect(totals.firstPass).toEqual({ doneOnFirstAttempt: 0, doneTotal: 1, rate: 0 });
    expect(totals.attemptsToDone).toEqual([]);
  });

  it('attributes a source-less plateau warning to the unspecified bucket', () => {
    const { totals } = foldOutcomeStats([legacySlice()]);

    expect(totals.plateau.attemptsWithPlateau).toBe(1);
    expect(totals.plateau.bySource).toEqual({ threshold: 0, diversity: 0, entropy: 0, unspecified: 1 });
    expect(totals.failedDimensions).toEqual([{ dimension: 'correctness', count: 1 }]);
  });

  it('falls back to the verdict map keys when the declared checklist is missing', () => {
    const { totals } = foldOutcomeStats([legacySlice()]);

    expect(totals.criteria).toEqual({
      tasksWithVerdicts: 1,
      declared: 2,
      passed: 1,
      failed: 1,
      unknown: 0,
      passRate: 0.5,
    });
  });

  it('ignores a blank escalation stamp instead of crediting a rung', () => {
    const { totals } = foldOutcomeStats([legacySlice()]);

    expect(totals.escalation.model.granted).toBe(0);
    expect(totals.escalation.nudge.granted).toBe(0);
  });

  it('tolerates a slice whose sprint or task list is missing', () => {
    const stats = foldOutcomeStats([{ sprint: undefined, tasks: undefined } as unknown as SprintWithTasks]);

    expect(stats.sprintCount).toBe(1);
    expect(stats.bySprint[0]?.sprintId).toBe('');
    expect(stats.bySprint[0]?.sprintName).toBe('');
    expect(stats.totals.taskCount).toBe(0);
  });
});

// ───────────────────────── regression / failure taxonomy ─────────────────────────

/** Records written before a given field existed, or by a future version. Cast deliberately. */
const legacyTask = (raw: Record<string, unknown>): Task => raw as unknown as Task;

/** One task whose four attempts carry one of each attribution verdict. */
const attributionSprint = (): SprintWithTasks => {
  const seed = makeTodoTask({ name: 'attrib', maxAttempts: 8 });
  const afterClean = failAttempt(withAttribution(beginAttempt(seed), 'clean'));
  const afterRegressed = failAttempt(withAttribution(beginAttempt(afterClean), 'regressed'));
  const afterBroken = failAttempt(withAttribution(beginAttempt(afterRegressed), 'baseline-broken'));
  return sprintWith([completeDone(withAttribution(beginAttempt(afterBroken), 'fixed-baseline'))]);
};

describe('foldOutcomeStats — attribution taxonomy', () => {
  it('counts every verdict and reports the regression rate over ATTRIBUTED attempts', () => {
    const { totals } = foldOutcomeStats([attributionSprint()]);

    expect(totals.attemptCount).toBe(4);
    expect(totals.attribution.byVerdict).toEqual({
      clean: 1,
      regressed: 1,
      'baseline-broken': 1,
      'fixed-baseline': 1,
      unspecified: 0,
    });
    expect(totals.attribution.attributed).toBe(4);
    expect(totals.attribution.regressionRate).toBe(0.25);
    expect(totals.attribution.tasksWithRegression).toBe(1);
  });

  it('parks attempts with no verdict in `unspecified`, out of the denominator and never NaN', () => {
    const { totals } = foldOutcomeStats([multiAttemptSprint()]);

    expect(totals.attemptCount).toBe(5);
    expect(totals.attribution.byVerdict.unspecified).toBe(5);
    expect(totals.attribution.attributed).toBe(0);
    expect(totals.attribution.regressionRate).toBe(0);
    expect(Number.isNaN(totals.attribution.regressionRate)).toBe(false);
    expect(totals.attribution.tasksWithRegression).toBe(0);
  });

  it('buckets an unrecognised historical verdict string as `unspecified` instead of throwing', () => {
    const slice = sprintWith([
      legacyTask({
        id: 'ancient',
        name: 'ancient',
        status: 'blocked',
        order: 1,
        attempts: [{ n: 1, status: 'failed', attribution: 'flaky' }],
      }),
    ]);

    const { totals } = foldOutcomeStats([slice]);

    expect(totals.attribution.byVerdict.unspecified).toBe(1);
    expect(totals.attribution.attributed).toBe(0);
    expect(totals.attribution.byVerdict.regressed).toBe(0);
  });

  it('counts a task once in `tasksWithRegression` however many of its attempts regressed', () => {
    const seed = makeTodoTask({ name: 'serial regressor', maxAttempts: 5 });
    const first = failAttempt(withAttribution(beginAttempt(seed), 'regressed'));
    const second = failAttempt(withAttribution(beginAttempt(first), 'regressed'));
    const clean = sprintWith([
      second,
      completeDone(withAttribution(beginAttempt(makeTodoTask({ name: 'ok' })), 'clean')),
    ]);

    const { totals } = foldOutcomeStats([clean]);

    expect(totals.attribution.byVerdict.regressed).toBe(2);
    expect(totals.attribution.tasksWithRegression).toBe(1);
    expect(totals.attribution.attributed).toBe(3);
  });
});

describe('foldOutcomeStats — warning taxonomy', () => {
  it('splits every warning kind instead of collapsing them into one counter', () => {
    const seed = makeTodoTask({ name: 'warned', maxAttempts: 8 });
    const budget = failAttempt(beginAttempt(seed), { kind: 'budget-exhausted', turnsUsed: 8, turnBudget: 8 });
    const malformed = failAttempt(beginAttempt(budget), { kind: 'malformed', detail: 'no signal' });
    const verifyFailed = failAttempt(beginAttempt(malformed), { kind: 'verify-failed', exitCode: 1, stderr: 'boom' });
    const crashed = failAttempt(beginAttempt(verifyFailed), { kind: 'crashed', detail: 'ENOENT' });
    const done = completeDone(beginAttempt(crashed), PLATEAU_THRESHOLD);

    const { totals } = foldOutcomeStats([sprintWith([done])]);

    expect(totals.warnings.byKind).toEqual({
      'budget-exhausted': 1,
      plateau: 1,
      malformed: 1,
      'verify-failed': 1,
      crashed: 1,
      unknown: 0,
    });
    expect(totals.warnings.attemptsWithWarning).toBe(5);
  });

  it('keeps the warning taxonomy consistent with the plateau block', () => {
    const { totals } = foldOutcomeStats([multiAttemptSprint()]);

    expect(totals.warnings.byKind.plateau).toBe(totals.plateau.attemptsWithPlateau);
    expect(totals.warnings.byKind['budget-exhausted']).toBe(1);
  });

  it('buckets an unrecognised historical warning kind as `unknown` instead of throwing', () => {
    const slice = sprintWith([
      legacyTask({
        id: 'ancient-warning',
        name: 'ancient warning',
        status: 'blocked',
        order: 1,
        attempts: [{ n: 1, status: 'failed', warning: { kind: 'ancient-kind' } }],
      }),
    ]);

    const { totals } = foldOutcomeStats([slice]);

    expect(totals.warnings.byKind.unknown).toBe(1);
    expect(totals.warnings.attemptsWithWarning).toBe(1);
    expect(totals.plateau.attemptsWithPlateau).toBe(0);
  });
});

describe('foldOutcomeStats — abort causes', () => {
  it('splits every abort cause so an operator cancel is distinguishable from rate-limit exhaustion', () => {
    const seed = makeTodoTask({ name: 'aborted', maxAttempts: 9 });
    const a1 = abortAttempt(beginAttempt(seed), 'user-cancel');
    const a2 = abortAttempt(beginAttempt(a1), 'sigterm');
    const a3 = abortAttempt(beginAttempt(a2), 'watchdog-killed');
    const a4 = abortAttempt(beginAttempt(a3), 'rate-limit-exhausted');
    const a5 = abortAttempt(beginAttempt(a4), 'process-crash');
    const a6 = abortAttempt(beginAttempt(a5), 'self-blocked');
    const a7 = abortAttempt(beginAttempt(a6), 'unknown');

    const { totals } = foldOutcomeStats([sprintWith([a7])]);

    expect(totals.aborts.byCause).toEqual({
      'user-cancel': 1,
      sigterm: 1,
      'watchdog-killed': 1,
      'rate-limit-exhausted': 1,
      'process-crash': 1,
      'self-blocked': 1,
      unknown: 1,
    });
    expect(totals.aborts.attemptsAborted).toBe(7);
  });

  it('folds an absent or unrecognised cause into `unknown` and ignores a non-aborted attempt', () => {
    const slice = sprintWith([
      legacyTask({
        id: 'legacy-aborts',
        name: 'legacy aborts',
        status: 'blocked',
        order: 1,
        attempts: [
          { n: 1, status: 'aborted' },
          { n: 2, status: 'aborted', abortCause: 'meteor-strike' },
          // A terminal non-abort attempt carrying a stale cause must NOT inflate the abort total.
          { n: 3, status: 'verified', abortCause: 'user-cancel' },
        ],
      }),
    ]);

    const { totals } = foldOutcomeStats([slice]);

    expect(totals.aborts.attemptsAborted).toBe(2);
    expect(totals.aborts.byCause.unknown).toBe(2);
    expect(totals.aborts.byCause['user-cancel']).toBe(0);
  });
});

describe('foldOutcomeStats — attempt-based denominator', () => {
  it('counts every attempt including the one still running', () => {
    const running = beginAttempt(failAttempt(beginAttempt(makeTodoTask({ name: 'live', maxAttempts: 4 }))));

    const { totals } = foldOutcomeStats([sprintWith([running, ...multiAttemptSprint().tasks])]);

    expect(totals.attemptCount).toBe(7);
  });

  it('zeroes every taxonomy key for empty input rather than omitting them', () => {
    const { totals } = foldOutcomeStats([]);

    expect(totals.attemptCount).toBe(0);
    expect(totals.attribution).toEqual({
      attributed: 0,
      byVerdict: { clean: 0, regressed: 0, 'baseline-broken': 0, 'fixed-baseline': 0, unspecified: 0 },
      regressionRate: 0,
      tasksWithRegression: 0,
    });
    expect(totals.warnings).toEqual({
      attemptsWithWarning: 0,
      byKind: { 'budget-exhausted': 0, plateau: 0, malformed: 0, 'verify-failed': 0, crashed: 0, unknown: 0 },
    });
    expect(totals.aborts).toEqual({
      attemptsAborted: 0,
      byCause: {
        'user-cancel': 0,
        sigterm: 0,
        'watchdog-killed': 0,
        'rate-limit-exhausted': 0,
        'process-crash': 0,
        'self-blocked': 0,
        unknown: 0,
      },
    });
  });
});

describe('foldTaskRollup — the sprint-less entry point', () => {
  it('folds a loose task list to the same rollup foldOutcomeStats derives for one sprint', () => {
    const slice = attributionSprint();

    expect(foldTaskRollup(slice.tasks)).toEqual(foldOutcomeStats([slice]).totals);
  });

  it('tolerates a legacy task whose attempts array is missing entirely', () => {
    expect(() => foldTaskRollup([legacyTask({ id: 'x', name: 'x', status: 'todo', order: 1 })])).not.toThrow();
    expect(foldTaskRollup([legacyTask({ id: 'x', name: 'x', status: 'todo', order: 1 })]).attemptCount).toBe(0);
  });
});
