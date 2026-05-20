/**
 * TasksPanel render caps — regression for the OOM mode where long gen-eval loops appended
 * hundreds of sub-steps and dozens of evaluations per task. Without per-list slicing every
 * spinner heartbeat re-reconciled an unbounded child array; V8 walked off the heap after ~1h.
 *
 * These tests pin the caps + the elision row wording so a future "just render everything"
 * regression fails loudly.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskSubStep } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const subStep = (i: number): TaskSubStep => ({
  leafName: `leaf-${String(i).padStart(3, '0')}`,
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

describe('TasksPanel render caps', () => {
  it('renders only the last maxSubStepsPerTask sub-steps with an elision row above', () => {
    const subSteps: TaskSubStep[] = Array.from({ length: 200 }, (_, i) => subStep(i));
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps,
          evaluations: [],
          signals: [],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };

    const r = render(<TasksPanel bucketed={bucketed} running={true} />);
    const frame = r.lastFrame() ?? '';

    // Default cap is 12 → 200 - 12 = 188 elided.
    expect(frame).toContain('… 188 earlier sub-steps');

    // The last 12 leaf names (188..199) are rendered.
    for (let i = 188; i < 200; i++) {
      expect(frame).toContain(`leaf-${String(i).padStart(3, '0')}`);
    }
    // Anything older than the cap must NOT appear (spot-check a few).
    expect(frame).not.toContain('leaf-187');
    expect(frame).not.toContain('leaf-000');

    r.unmount();
  });

  it('renders the resume-from-aborted banner under the header when recovering is set', () => {
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const recovering = new Map<string, RecoveryContext>([
      [
        'task-1',
        {
          fromAttemptN: 3,
          cause: 'sigterm',
          // 19:41 UTC — pinned so the snapshot can assert the HH:MM clip directly.
          abortedAt: ts(19 * 3600 + 41 * 60) as IsoTimestamp,
        },
      ],
    ]);

    const r = render(<TasksPanel bucketed={bucketed} running={true} recoveringByTaskId={recovering} />);
    const frame = r.lastFrame() ?? '';

    // The new attempt N+1 = 4 — the running attempt that just opened after settling N=3.
    expect(frame).toContain('attempt 4');
    expect(frame).toContain('resumed from aborted 3');
    expect(frame).toContain('19:41');
    expect(frame).toContain('(SIGTERM)');

    r.unmount();
  });

  it('omits the resume-from-aborted banner when recoveringByTaskId is absent', () => {
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={bucketed} running={true} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('resumed from aborted');
    r.unmount();
  });

  it('omits the parenthetical cause when cause is unknown (legacy data path)', () => {
    // Reflects the legacy-data path: an aborted attempt without a recorded cause loads
    // as `cause: 'unknown'`; the banner should still render the resume line, just
    // without the trailing `(label)` so we don't spam `(unknown)` chrome.
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const recovering = new Map<string, RecoveryContext>([
      [
        'task-1',
        {
          fromAttemptN: 1,
          cause: 'unknown',
          abortedAt: ts(0) as IsoTimestamp,
        },
      ],
    ]);
    const r = render(<TasksPanel bucketed={bucketed} running={true} recoveringByTaskId={recovering} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('resumed from aborted 1');
    expect(frame).not.toContain('(unknown)');
    r.unmount();
  });

  it('renders only the last maxEvaluationsPerTask evaluations with an elision row above', () => {
    const evaluations: EvaluationSignal[] = Array.from({ length: 50 }, (_, i) => evaluation(i));
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations,
          signals: [],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };

    const r = render(<TasksPanel bucketed={bucketed} running={true} />);
    const frame = r.lastFrame() ?? '';

    // Default cap is 6 → 50 - 6 = 44 elided.
    expect(frame).toContain('… 44 earlier evaluations');

    // Each rendered evaluation shows its score as "<score>/5.0" — exactly 6 should appear.
    const evalScoreCount = frame.split('5.0/5.0').length - 1;
    expect(evalScoreCount).toBe(6);

    r.unmount();
  });
});
