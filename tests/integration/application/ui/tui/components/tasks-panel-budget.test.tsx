/**
 * Render-budget fence for TasksPanel. Catches the OOM class — "some descendant component
 * renders an unbounded child array driven by the 90 ms spinner heartbeat" — without naming
 * the offending array. If a future author deletes the `.slice()` from any nested list
 * (sub-steps, evaluations, signals, orphan signals), the worst-case fixture explodes past the
 * line / character ceilings and the test fails loudly with "frame too large".
 *
 * The fixture is intentionally adversarial:
 *   20 tasks × 500 sub-steps × 30 evaluations × 200 signals + 100 orphan signals.
 *
 * Without the existing per-task caps the rendered frame would be on the order of tens of
 * thousands of lines and millions of characters; with the caps it stays well under both
 * ceilings (current caps yield ~520 lines for this shape).
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type {
  BucketedExecution,
  TaskBucket,
  TaskSubStep,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { ChangeSignal, EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)).toISOString() as IsoTimestamp;

const subStep = (i: number): TaskSubStep => ({
  leafName: `leaf-${String(i).padStart(4, '0')}`,
  status: 'completed',
  durationMs: 1,
});

const evaluation = (i: number): EvaluationSignal => ({
  type: 'evaluation',
  status: 'passed',
  dimensions: [],
  overallScore: 5,
  timestamp: ts(i),
});

const changeSignal = (taskIdx: number, sigIdx: number): ChangeSignal => ({
  type: 'change',
  text: `task-${String(taskIdx)} change ${String(sigIdx)}`,
  timestamp: ts(sigIdx),
});

const buildWorstCaseFixture = (): BucketedExecution => {
  const tasks: TaskBucket[] = Array.from({ length: 20 }, (_outerUnused, taskIdx) => ({
    id: `01933fbb-0000-7000-8000-${String(taskIdx).padStart(12, '0')}`,
    status: 'running',
    subSteps: Array.from({ length: 500 }, (_subUnused, i) => subStep(i)),
    evaluations: Array.from({ length: 30 }, (_evalUnused, i) => evaluation(i)),
    signals: Array.from({ length: 200 }, (_sigUnused, i) => changeSignal(taskIdx, i)),
    genEvalRound: 0,
  }));
  const orphanSignals: HarnessSignal[] = Array.from({ length: 100 }, (_orphanUnused, i) => changeSignal(-1, i));
  return { tasks, orphanSignals };
};

describe('TasksPanel render budget', () => {
  it('keeps the worst-case frame under hard line / character ceilings', () => {
    const bucketed = buildWorstCaseFixture();
    const r = render(<TasksPanel bucketed={bucketed} running={true} />);
    const frame = r.lastFrame() ?? '';

    // Line ceiling — current per-task caps (12 sub-steps + 6 evaluations + 8 signals + chrome)
    // yield roughly 25 lines × 20 tasks + legend / orphans ≈ 520 lines. 800 leaves margin
    // without being toothless; if any descendant list silently uncaps, this trips first.
    const lineCount = frame.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(800);

    // Character ceiling — bounds the worst-case Ink reconciliation cost. Calibrated by
    // measuring the actual fixture (~37k chars in practice) and rounding generously up.
    expect(frame.length).toBeLessThanOrEqual(80_000);

    // Truncation must actually happen — the elision row proves the descendant `.slice()`
    // calls fired. Without this assertion a regression that produced a tiny frame for some
    // unrelated reason (e.g. broken rendering) would silently pass the ceilings.
    expect(frame).toContain('… 488 earlier sub-steps');

    r.unmount();
  });
});
