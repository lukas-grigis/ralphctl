/**
 * Stats consumed by the `CancelScopeOverlay`:
 *
 *   - `attemptStartedAt`: wall-clock ms of the most recent `task-attempt-started` event for the
 *     active task. The caller computes elapsed from `now - attemptStartedAt` so this memo does
 *     not re-scan chainEvents on every clock tick. Undefined when no attempt has started yet.
 *   - `remainingTaskCount`: count of non-completed buckets, including the in-flight one.
 *     Surfaced as "N other tasks still queued" on the flow-cancel option.
 */

import { useMemo } from 'react';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

interface UseCancelScopeStatsInput {
  readonly chainEvents: readonly AppEvent[];
  readonly currentTask: TaskBucket | undefined;
  readonly bucketed: BucketedExecution | undefined;
}

export interface CancelScopeStats {
  readonly attemptStartedAt: number | undefined;
  readonly remainingTaskCount: number;
}

export const useCancelScopeStats = ({
  chainEvents,
  currentTask,
  bucketed,
}: UseCancelScopeStatsInput): CancelScopeStats => {
  const attemptStartedAt = useMemo<number | undefined>(() => {
    if (currentTask === undefined) return undefined;
    let latestStartMs: number | undefined;
    for (const ev of chainEvents) {
      if (ev.type !== 'task-attempt-started') continue;
      if (ev.taskId !== currentTask.id) continue;
      const ms = new Date(String(ev.at)).getTime();
      if (latestStartMs === undefined || ms > latestStartMs) latestStartMs = ms;
    }
    return latestStartMs;
  }, [chainEvents, currentTask]);

  const remainingTaskCount = useMemo<number>(() => {
    if (bucketed === undefined) return 0;
    return bucketed.tasks.reduce((n, t) => (t.status === 'completed' ? n : n + 1), 0);
  }, [bucketed]);

  return { attemptStartedAt, remainingTaskCount };
};
