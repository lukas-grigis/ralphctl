import { describe, expect, it } from 'vitest';
import { renderOutcomeStats } from '@src/application/ui/cli/commands/runs-stats-report.ts';
import { foldOutcomeStats, type OutcomeStats } from '@src/business/runs/outcome-stats.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { setAttemptAttribution, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import type { AbortCause, Attribution } from '@src/domain/entity/attempt.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import type { Result } from '@src/domain/result.ts';
import {
  FIXED_LATER,
  FIXED_NOW,
  makeDoneTask,
  makeDoneTaskWithWarning,
  makeDraftSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

const render = (tasks: readonly Task[]): string =>
  renderOutcomeStats(foldOutcomeStats([{ sprint: makeDraftSprint({ name: 'a sprint' }), tasks }]));

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(`fixture unwrap failed: ${JSON.stringify(result.error)}`);
  return result.value as T;
};

const blocked = (name: string): Task => {
  const result = markTaskBlocked(makeTodoTask({ name }), 'wedged', 'own');
  if (!result.ok) throw new Error(`fixture: ${result.error.message}`);
  return result.value;
};

const beginAttempt = (task: Task): InProgressTask => unwrap(startNextAttempt(task, FIXED_NOW, 'session-1'));

/** A task whose single failed attempt carries the given attribution verdict. */
const attributedTask = (name: string, attribution: Attribution): Task =>
  unwrap(
    failCurrentAttempt(
      unwrap(setAttemptAttribution(beginAttempt(makeTodoTask({ name })), attribution)),
      FIXED_LATER,
      'failed'
    )
  );

/** A task whose single attempt was aborted for the given cause. */
const abortedTask = (name: string, abortCause: AbortCause): Task =>
  unwrap(failCurrentAttempt(beginAttempt(makeTodoTask({ name })), FIXED_LATER, 'aborted', { abortCause }));

/** The escalation table row for one rung, split on the alignment whitespace. */
const rungRow = (report: string, rung: string): readonly string[] =>
  (report.split('\n').find((line) => line.trim().startsWith(`${rung} `)) ?? '').trim().split(/\s+/);

describe('renderOutcomeStats', () => {
  it('renders every section for an all-zero rollup rather than blank space', () => {
    const report = renderOutcomeStats(foldOutcomeStats([]));

    expect(report).toContain('Harness outcomes — 0 sprints · 0 tasks');
    expect(report).toContain('0/0 done on attempt 1 (0.0%)');
    expect(report).toContain('(no done task carries an attempt count yet)');
    expect(report).toContain('(no escalation rung fired)');
    expect(report).toContain('(no plateau recorded a failed dimension)');
    // No per-sprint section when there are no sprints to break down.
    expect(report).not.toContain('By sprint');
    expect(report.endsWith('\n')).toBe(true);
  });

  it('splits the done count into clean vs warned', () => {
    const report = render([makeDoneTask({ name: 'clean' }), makeDoneTaskWithWarning({ name: 'warned' })]);
    expect(report).toContain('(clean 1 · with warning 1)');
  });

  it('tabulates only the rungs that actually fired', () => {
    const escalated: Task = {
      ...makeDoneTask({ name: 'escalated' }),
      escalatedFromModel: 'small',
      escalatedToModel: 'big',
    };
    const nudged: Task = { ...blocked('nudged'), escalatedFromModel: 'big', escalatedToModel: 'big' };

    const report = render([escalated, nudged]);

    expect(report).toContain('rung              granted  resolved  fell-through  unsettled');
    // granted / resolved / fell-through / unsettled, read off the aligned row.
    expect(rungRow(report, 'model')).toEqual(['model', '1', '1', '0', '0']);
    expect(rungRow(report, 'nudge')).toEqual(['nudge', '1', '0', '1', '0']);
    expect(report).not.toContain('best-of-n');
  });

  it('labels each section with the denominator it is quoting so the rates are not read as comparable', () => {
    const report = render([
      attributedTask('regressor', 'regressed'),
      attributedTask('tidy', 'clean'),
      makeDoneTask({ name: 'landed' }),
    ]);

    expect(report).toContain('Harness outcomes — 1 sprint · 3 tasks · 3 attempts');
    expect(report).toContain('Outcome mix (of 3 tasks)');
    expect(report).toContain('Attempts to done (of 1 done task)');
    expect(report).toContain('Attribution (of 3 attempts)');
    expect(report).toContain('Warnings (of 3 attempts)');
    expect(report).toContain('Aborts (of 3 attempts)');
    expect(report).toContain('Escalation rungs (of 3 tasks)');
    expect(report).toContain('— of 3 tasks');
    expect(report).toContain('— of 3 attempts');
    expect(report).toContain('1 attempt broke a green baseline (50.0% of 2 attributed attempts)');
  });

  it('always renders the regression row, even at zero, and names the empty warning / abort states', () => {
    const report = render([attributedTask('tidy', 'clean')]);

    expect(report).toMatch(/^ {2}regressed {2,}0$/m);
    expect(report).toMatch(/^ {2}clean {2,}1$/m);
    expect(report).toContain('(no attempt carried a warning)');
    expect(report).toContain('(no attempt was aborted)');
  });

  it('reports the unattributed slot rather than pretending an unverified attempt was clean', () => {
    const report = render([attributedTask('checked', 'clean'), makeDoneTask({ name: 'no verify script' })]);

    expect(report).toMatch(/^ {2}unattributed {2,}1$/m);
    expect(report).toContain('(0.0% of 1 attributed attempt)');
  });

  it('says there is no evidence, not "zero regressions", when nothing carries a verdict at all', () => {
    const report = render([makeDoneTask({ name: 'no verify script' })]);

    expect(report).toContain('(no attempt carries an attribution verdict)');
    expect(report).not.toContain('broke a green baseline');
    expect(report).not.toMatch(/^ {2}regressed/m);
  });

  it('keeps the widest taxonomy label off its own count column', () => {
    const report = render([abortedTask('throttled', 'rate-limit-exhausted'), abortedTask('cancelled', 'user-cancel')]);

    expect(report).toMatch(/^ {2}rate-limit-exhausted {2,}1$/m);
    expect(report).toMatch(/^ {2}user-cancel {2,}1$/m);
    expect(report).toContain('Aborts (of 2 attempts)');
  });

  it('flags a regressing sprint on its per-sprint line only when one regressed', () => {
    const stats = foldOutcomeStats([
      { sprint: makeDraftSprint({ name: 'bad sprint' }), tasks: [attributedTask('regressor', 'regressed')] },
      { sprint: makeDraftSprint({ name: 'good sprint' }), tasks: [attributedTask('tidy', 'clean')] },
    ]);

    const lines = renderOutcomeStats(stats).split('\n');
    const flagged = lines.filter((line) => line.includes('· 1 regressed'));

    expect(flagged).toHaveLength(1);
    expect(lines.indexOf(flagged[0] ?? '')).toBe(lines.findIndex((line) => line.includes('bad sprint')) + 1);
  });

  /** The per-sprint line is task-scoped throughout, so its regression field counts TASKS. */
  it('counts a twice-regressing task once on the per-sprint line', () => {
    const twice = unwrap(
      failCurrentAttempt(
        unwrap(setAttemptAttribution(beginAttempt(attributedTask('serial', 'regressed')), 'regressed')),
        FIXED_LATER,
        'failed'
      )
    );
    const report = renderOutcomeStats(
      foldOutcomeStats([
        { sprint: makeDraftSprint({ name: 'bad sprint' }), tasks: [twice] },
        // A second sprint — the per-sprint breakdown only renders for a multi-sprint scope.
        { sprint: makeDraftSprint({ name: 'good sprint' }), tasks: [attributedTask('tidy', 'clean')] },
      ])
    );

    // Two regressed attempts in the Attribution block, one regressing task on the sprint line.
    expect(report).toMatch(/^ {2}regressed {2,}2$/m);
    expect(report).toContain('· 1 regressed');
  });

  it('caps the failed-dimension histogram and points at --json for the tail', () => {
    const dimensions = Array.from({ length: 11 }, (_, i) => `dimension-${String(i).padStart(2, '0')}`);
    const report = render([makeDoneTaskWithWarning({ name: 'plateaued', warning: { kind: 'plateau', dimensions } })]);

    expect(report).toContain('dimension-00');
    expect(report).not.toContain('dimension-08');
    expect(report).toContain('… 3 more dimensions (use --json for the full histogram)');
  });

  /**
   * Drift fence. The fold's zero records are exhaustive over their unions, so a new warning kind /
   * abort cause is forced into the ROLLUP at compile time — but the curated `*_ORDER` arrays here
   * cannot be, and a key missing from one used to be dropped from the report without a trace.
   * Hand-built because `foldOutcomeStats` can only emit the keys this build knows about.
   */
  it('still renders a taxonomy key its curated order array has never heard of', () => {
    const base = foldOutcomeStats([{ sprint: makeDraftSprint({ name: 'a sprint' }), tasks: [] }]);
    const widened = {
      ...base,
      totals: {
        ...base.totals,
        attemptCount: 2,
        warnings: { attemptsWithWarning: 1, byKind: { ...base.totals.warnings.byKind, 'time-travelled': 1 } },
        aborts: { attemptsAborted: 1, byCause: { ...base.totals.aborts.byCause, 'meteor-strike': 1 } },
      },
    } as unknown as OutcomeStats;

    const report = renderOutcomeStats(widened);

    expect(report).toMatch(/^ {2}time-travelled +1$/m);
    expect(report).toMatch(/^ {2}meteor-strike +1$/m);
  });
});
