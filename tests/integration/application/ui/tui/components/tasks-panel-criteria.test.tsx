/**
 * TasksPanel — done-criteria summary + per-criterion verdict mapping.
 *
 * The panel surfaces the task's `done-criteria.md` (materialised by the implement chain at
 * `<sprintDir>/implement/<task-id>/done-criteria.md`) as a collapsed 3-line preview with a
 * `press e to expand` hint. When the operator presses `e` (while the panel owns input), the
 * full bullet list expands.
 *
 * The evaluator's per-row dimension scores are remapped to the criterion bullets when the
 * counts match (deterministic fuzzy mapping). On mismatch the existing dimension fallback is
 * preserved — the panel never fabricates per-criterion attribution.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const criteriaBlob = (bullets: readonly string[]): string =>
  `# Done criteria — Demo\n\n${bullets.map((b) => `- ${b}`).join('\n')}\n`;

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

describe('TasksPanel done-criteria summary', () => {
  it('renders the first 3 criteria bullets and a "press e to expand" hint when the loader resolves a 4-bullet file', async () => {
    const reader = async (): Promise<string> =>
      criteriaBlob([
        'Add canvas-confetti dependency',
        'Wire confetti to landing-page mount',
        'Gate on prefers-reduced-motion',
        'Document the feature in README',
      ]);

    const r = render(<TasksPanel bucketed={baseBucket()} running={true} readDoneCriteria={reader} />);
    await tick(40);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('criteria');
    expect(frame).toContain('press e to expand');
    expect(frame).toContain('Add canvas-confetti dependency');
    expect(frame).toContain('Wire confetti to landing-page mount');
    expect(frame).toContain('Gate on prefers-reduced-motion');
    // 4th bullet hidden in collapsed mode; the "X more" tail surfaces the overflow count.
    expect(frame).not.toContain('Document the feature in README');
    expect(frame).toContain('1 more');

    r.unmount();
  });

  it('expands the full criteria block when `e` is pressed while the panel owns input', async () => {
    const reader = async (): Promise<string> =>
      criteriaBlob(['First criterion', 'Second criterion', 'Third criterion', 'Hidden in collapsed view']);

    const r = render(
      <TasksPanel bucketed={baseBucket()} running={true} inputActive={true} readDoneCriteria={reader} />
    );
    await tick(40);
    r.stdin.write('e');
    await tick(30);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('Hidden in collapsed view');
    expect(frame).toContain('press e to collapse');
    r.unmount();
  });

  it('omits the criteria block entirely when the loader returns undefined', async () => {
    const reader = async (): Promise<string | undefined> => undefined;

    const r = render(<TasksPanel bucketed={baseBucket()} running={true} readDoneCriteria={reader} />);
    await tick(40);
    const frame = r.lastFrame() ?? '';

    expect(frame).not.toContain('criteria');
    expect(frame).not.toContain('press e to expand');
    r.unmount();
  });

  it('per-criterion verdict mapping pairs criterion bullets with evaluator dimensions when counts match', async () => {
    const reader = async (): Promise<string> =>
      criteriaBlob(['Correctness criterion', 'Completeness criterion', 'Style criterion', 'Tests criterion']);

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
      <TasksPanel bucketed={baseBucket({ evaluations: [evaluation] })} running={true} readDoneCriteria={reader} />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';

    // Each criterion text renders alongside its `n/5` score (multiple sites: the criteria block
    // AND the per-criterion eval mapping). At minimum the eval mapping row carries the score.
    expect(frame).toContain('Correctness criterion');
    expect(frame).toContain('Tests criterion');
    // Default rendering of the 4-dim fallback joins with the em-bullet glyph; the per-criterion
    // form replaces it with a per-row layout. Spot-check that the "dimension: N/5" pattern
    // (used by the fallback) is absent — i.e., the fused renderer fired.
    expect(frame).not.toMatch(/correctness: 5\/5/);

    r.unmount();
  });

  it('falls back to the 4-dimension scores when criterion count and dimension count disagree', async () => {
    const reader = async (): Promise<string> => criteriaBlob(['Only one criterion']);

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
      <TasksPanel bucketed={baseBucket({ evaluations: [evaluation] })} running={true} readDoneCriteria={reader} />
    );
    await tick(40);
    const frame = r.lastFrame() ?? '';

    // Mismatch — fallback dimension labels must be present.
    expect(frame).toMatch(/correctness: 5\/5/);
    expect(frame).toMatch(/completeness: 4\/5/);
    r.unmount();
  });
});
