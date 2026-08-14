import { describe, expect, it } from 'vitest';
import { renderOutcomeStats } from '@src/application/ui/cli/commands/runs-stats-report.ts';
import { foldOutcomeStats } from '@src/business/runs/outcome-stats.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { makeDoneTask, makeDoneTaskWithWarning, makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

const render = (tasks: readonly Task[]): string =>
  renderOutcomeStats(foldOutcomeStats([{ sprint: makeDraftSprint({ name: 'a sprint' }), tasks }]));

const blocked = (name: string): Task => {
  const result = markTaskBlocked(makeTodoTask({ name }), 'wedged', 'own');
  if (!result.ok) throw new Error(`fixture: ${result.error.message}`);
  return result.value;
};

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

  it('caps the failed-dimension histogram and points at --json for the tail', () => {
    const dimensions = Array.from({ length: 11 }, (_, i) => `dimension-${String(i).padStart(2, '0')}`);
    const report = render([makeDoneTaskWithWarning({ name: 'plateaued', warning: { kind: 'plateau', dimensions } })]);

    expect(report).toContain('dimension-00');
    expect(report).not.toContain('dimension-08');
    expect(report).toContain('… 3 more dimensions (use --json for the full histogram)');
  });
});
