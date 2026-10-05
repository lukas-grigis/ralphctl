/**
 * TasksPanel render caps — regression for the OOM mode where long gen-eval loops appended
 * hundreds of sub-steps per task. Without per-list slicing every spinner heartbeat re-reconciled
 * an unbounded child array; V8 walked off the heap after ~1h.
 *
 * The card no longer renders the bucketed evaluation signal stream at all (the verdict is sourced
 * from the authoritative per-task `taskEvaluationById` map — one line, no unbounded list), so
 * there is no eval-cap regression to pin here any more.
 *
 * These tests pin the step-tree row budget + the overflow cue so a future "just render everything"
 * regression fails loudly.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { StepView } from '@src/application/ui/tui/runtime/flow-progress.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const leafStep = (i: number, status: StepView['status'] = 'completed'): StepView => ({
  key: `leaf-${String(i)}`,
  label: `leaf-${String(i).padStart(3, '0')}`,
  status,
  depth: 3,
  durationMs: 1,
  children: [],
});

/** A task root whose children are `count` finished leaves followed by one running leaf. */
const longTree = (count: number): StepView => ({
  key: 'task-1',
  label: 'task-1',
  status: 'running',
  depth: 2,
  children: [...Array.from({ length: count }, (_, i) => leafStep(i)), leafStep(count, 'running')],
});

describe('TasksPanel render caps', () => {
  it('windows the step tree to the row budget, anchored on the running row', () => {
    const bucketed: BucketedExecution = {
      tasks: [{ id: 'task-1', status: 'running', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 }],
      orphanSignals: [],
    };

    const r = render(
      <TasksPanel bucketed={bucketed} running={true} stepTreeByTaskId={new Map([['task-1', longTree(200)]])} />
    );
    const frame = r.lastFrame() ?? '';

    // Default budget is 12 rows, one of them the overflow cue.
    expect(frame).toContain('▴ 190 more');
    expect(frame.match(/leaf-\d{3}/g)).toHaveLength(11);
    // The running row (the last leaf) is the anchor and stays visible; the head is windowed away.
    expect(frame).toContain('leaf-200');
    expect(frame).not.toContain('leaf-000');

    r.unmount();
  });

  it('renders the resume-from-aborted banner under the header when recovering is set', () => {
    // Pin TZ=UTC so fmtIsoHHMM converts the UTC timestamp to local HH:MM deterministically
    // across dev and CI environments.
    vi.stubEnv('TZ', 'UTC');
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
    // With TZ=UTC, local time == UTC time → 19:41.
    expect(frame).toContain('19:41');
    expect(frame).toContain('(SIGTERM)');

    r.unmount();
    vi.unstubAllEnvs();
  });

  it.each(['user-cancel', 'harness-interrupted'] as const)(
    'words a free resume (%s) without a raw attempt number that would contradict the chip',
    (cause) => {
      const bucketed: BucketedExecution = {
        tasks: [{ id: 'task-1', status: 'running', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 }],
        orphanSignals: [],
      };
      const recovering = new Map<string, RecoveryContext>([
        ['task-1', { fromAttemptN: 1, cause, abortedAt: ts(19 * 3600) as IsoTimestamp }],
      ]);
      const r = render(<TasksPanel bucketed={bucketed} running={true} recoveringByTaskId={recovering} />);
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('resumed after the stop at');
      expect(frame).toContain('no attempt used');
      expect(frame).not.toMatch(/attempt 2/);
      r.unmount();
    }
  );

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
});
