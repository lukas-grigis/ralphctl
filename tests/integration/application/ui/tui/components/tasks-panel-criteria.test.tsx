/**
 * TasksPanel — verification-criteria summary + per-criterion verdict mapping.
 *
 * Audit [05]: the panel renders criteria synchronously from `taskCriteriaById`, a map of
 * task id → `Task.verificationCriteria` supplied by the host. The legacy lazy loader (and
 * the on-disk `done-criteria.md`) are gone. The collapsed 3-line preview + `press e to
 * expand` behaviour stays unchanged; the source is just in-memory now.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const baseBucket = (overrides: Partial<BucketedExecution['tasks'][number]> = {}): BucketedExecution => ({
  tasks: [
    {
      id: 'task-1',
      status: 'running',
      subSteps: [],
      evaluations: [],
      signals: [],
      genEvalRound: 0,
      ...overrides,
    },
  ],
  orphanSignals: [],
});

const criteria = (bullets: readonly string[]): ReadonlyMap<string, readonly string[]> => new Map([['task-1', bullets]]);

describe('TasksPanel verification-criteria summary', () => {
  it('renders the first 3 criteria bullets and a "press e to expand" hint when 4 bullets supplied', async () => {
    const r = render(
      <TasksPanel
        bucketed={baseBucket()}
        running={true}
        taskCriteriaById={criteria([
          'Add canvas-confetti dependency',
          'Wire confetti to landing-page mount',
          'Gate on prefers-reduced-motion',
          'Document the feature in README',
        ])}
      />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('criteria');
    expect(frame).toContain('press e to expand');
    expect(frame).toContain('Add canvas-confetti dependency');
    expect(frame).toContain('Wire confetti to landing-page mount');
    expect(frame).toContain('Gate on prefers-reduced-motion');
    // 4th bullet hidden in collapsed mode; the `▼ more (N)` tail (audit-[03] multi-line
    // collapse marker — expand affordance available via `e`) surfaces the overflow count.
    expect(frame).not.toContain('Document the feature in README');
    expect(frame).toContain('▼ more (1)');

    r.unmount();
  });

  it('expands the full criteria block when `e` is pressed while the panel owns input', async () => {
    const r = render(
      <TasksPanel
        bucketed={baseBucket()}
        running={true}
        inputActive={true}
        taskCriteriaById={criteria([
          'First criterion',
          'Second criterion',
          'Third criterion',
          'Hidden in collapsed view',
        ])}
      />
    );
    await tick(40);
    r.stdin.write('e');
    await tick(30);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('Hidden in collapsed view');
    expect(frame).toContain('press e to collapse');
    r.unmount();
  });

  it('omits the criteria block entirely when the task has no criteria declared', async () => {
    const r = render(<TasksPanel bucketed={baseBucket()} running={true} taskCriteriaById={new Map()} />);
    await tick(40);
    const frame = r.lastFrame() ?? '';

    expect(frame).not.toContain('criteria');
    expect(frame).not.toContain('press e to expand');
    r.unmount();
  });

  it('per-criterion verdict mapping pairs criterion bullets with evaluator dimensions when counts match', async () => {
    const evaluation: EvaluationSignal = {
      type: 'evaluation',
      status: 'passed',
      overallScore: 4.5,
      timestamp: ts(10),
      dimensions: [
        { dimension: 'correctness', score: 5, passed: true, finding: 'ok' },
        { dimension: 'completeness', score: 4, passed: true, finding: 'ok' },
        { dimension: 'style', score: 5, passed: true, finding: 'ok' },
        { dimension: 'tests', score: 4, passed: true, finding: 'ok' },
      ],
    };

    const r = render(
      <TasksPanel
        bucketed={baseBucket({ evaluations: [evaluation] })}
        running={true}
        taskCriteriaById={criteria([
          'Correctness criterion',
          'Completeness criterion',
          'Style criterion',
          'Tests criterion',
        ])}
      />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('Correctness criterion');
    expect(frame).toContain('Tests criterion');
    expect(frame).not.toMatch(/correctness: 5\/5/);

    r.unmount();
  });

  it('falls back to the 4-dimension scores when criterion count and dimension count disagree', async () => {
    const evaluation: EvaluationSignal = {
      type: 'evaluation',
      status: 'passed',
      overallScore: 4.5,
      timestamp: ts(10),
      dimensions: [
        { dimension: 'correctness', score: 5, passed: true, finding: 'ok' },
        { dimension: 'completeness', score: 4, passed: true, finding: 'ok' },
        { dimension: 'style', score: 5, passed: true, finding: 'ok' },
        { dimension: 'tests', score: 4, passed: true, finding: 'ok' },
      ],
    };

    const r = render(
      <TasksPanel
        bucketed={baseBucket({ evaluations: [evaluation] })}
        running={true}
        taskCriteriaById={criteria(['Only one criterion'])}
      />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';

    expect(frame).toMatch(/correctness: 5\/5/);
    expect(frame).toMatch(/completeness: 4\/5/);
    r.unmount();
  });
});
