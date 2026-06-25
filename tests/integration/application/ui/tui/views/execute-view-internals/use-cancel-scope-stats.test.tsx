/**
 * Verify `useCancelScopeStats` — the memo that feeds the CancelScopeOverlay's "estimated wasted
 * output" hint and "N other tasks still queued" count. The hook must:
 *  - return `attemptStartedAt` = the LATEST `task-attempt-started` timestamp for the current task,
 *  - return `undefined` when the current task has no attempt event (or there is no current task),
 *  - count every non-completed bucket in `remainingTaskCount`,
 *  - return a RAW start timestamp with no wall-clock subtraction — the execute view derives
 *    elapsed inline so the O(chainEvents) scan does not re-run on every 1 Hz clock tick. This is
 *    the OOM-relevant invariant: re-introducing a `now` dependency here would resurrect the
 *    per-second full-array scan the fix removed.
 *
 * The hook is pure (useMemo only — no bus, no timers), so the initial synchronous render carries
 * the result; no drain is needed.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import type { AppEvent } from '@src/business/observability/events.ts';
import type {
  BucketedExecution,
  TaskBucket,
  TaskBucketStatus,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import {
  type CancelScopeStats,
  useCancelScopeStats,
} from '@src/application/ui/tui/views/execute-view-internals/use-cancel-scope-stats.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const makeTask = (id: string, status: TaskBucketStatus): TaskBucket => ({
  id,
  status,
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 0,
});

const attemptStarted = (taskId: string, at: string): AppEvent => ({
  type: 'task-attempt-started',
  taskId,
  sessionId: 'sess-1',
  at: isoTimestamp(at),
});

interface ProbeInput {
  readonly chainEvents: readonly AppEvent[];
  readonly currentTask: TaskBucket | undefined;
  readonly bucketed: BucketedExecution | undefined;
}

const renderStats = (input: ProbeInput): CancelScopeStats => {
  let captured: CancelScopeStats = { attemptStartedAt: undefined, remainingTaskCount: 0 };
  const Probe = (): React.JSX.Element => {
    captured = useCancelScopeStats(input);
    return <Text>{String(captured.remainingTaskCount)}</Text>;
  };
  const r = render(<Probe />);
  r.unmount();
  return captured;
};

describe('useCancelScopeStats', () => {
  it('returns the latest task-attempt-started timestamp for the current task', () => {
    const earlier = '2026-05-09T10:00:00.000Z';
    const later = '2026-05-09T10:05:00.000Z';
    const stats = renderStats({
      chainEvents: [
        attemptStarted('task-a', earlier),
        attemptStarted('task-b', '2026-05-09T10:02:00.000Z'), // other task — ignored
        attemptStarted('task-a', later), // newer attempt for the current task
      ],
      currentTask: makeTask('task-a', 'running'),
      bucketed: undefined,
    });

    // Raw event timestamp, NOT an elapsed delta — proves the `now` subtraction lives at the call
    // site, not in this memo. A regression that re-adds `now` here would fail this exact-equality.
    expect(stats.attemptStartedAt).toBe(new Date(later).getTime());
  });

  it('returns undefined when the current task has no attempt-started event', () => {
    const stats = renderStats({
      chainEvents: [attemptStarted('task-a', '2026-05-09T10:00:00.000Z')],
      currentTask: makeTask('task-z', 'running'),
      bucketed: undefined,
    });
    expect(stats.attemptStartedAt).toBeUndefined();
  });

  it('returns undefined when there is no current task', () => {
    const stats = renderStats({
      chainEvents: [attemptStarted('task-a', '2026-05-09T10:00:00.000Z')],
      currentTask: undefined,
      bucketed: undefined,
    });
    expect(stats.attemptStartedAt).toBeUndefined();
  });

  it('counts every non-completed bucket in remainingTaskCount', () => {
    const stats = renderStats({
      chainEvents: [],
      currentTask: undefined,
      bucketed: {
        tasks: [
          makeTask('t1', 'completed'),
          makeTask('t2', 'running'),
          makeTask('t3', 'pending'),
          makeTask('t4', 'failed'),
        ],
        orphanSignals: [],
      },
    });
    // 3 non-completed (running + pending + failed); the single completed task is excluded.
    expect(stats.remainingTaskCount).toBe(3);
  });

  it('reports zero remaining tasks when bucketed is undefined', () => {
    const stats = renderStats({ chainEvents: [], currentTask: undefined, bucketed: undefined });
    expect(stats.remainingTaskCount).toBe(0);
  });
});
