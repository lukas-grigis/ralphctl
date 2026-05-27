/**
 * Stats consumed by the `CancelScopeOverlay`:
 *
 *   - `attemptElapsedMs`: time since the most recent `task-attempt-started` event for the
 *     active task. Drives the overlay's "estimated wasted output" hint. Undefined when no
 *     attempt has started yet (e.g. preflight phase) — the overlay renders without the
 *     hint in that case.
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
  readonly now: number;
}

export interface CancelScopeStats {
  readonly attemptElapsedMs: number | undefined;
  readonly remainingTaskCount: number;
}

export const useCancelScopeStats = ({
  chainEvents,
  currentTask,
  bucketed,
  now,
}: UseCancelScopeStatsInput): CancelScopeStats => {
  const attemptElapsedMs = useMemo<number | undefined>(() => {
    if (currentTask === undefined) return undefined;
    let latestStartMs: number | undefined;
    for (const ev of chainEvents) {
      if (ev.type !== 'task-attempt-started') continue;
      if (ev.taskId !== currentTask.id) continue;
      const ms = new Date(String(ev.at)).getTime();
      if (latestStartMs === undefined || ms > latestStartMs) latestStartMs = ms;
    }
    return latestStartMs !== undefined ? Math.max(0, now - latestStartMs) : undefined;
  }, [chainEvents, currentTask, now]);

  const remainingTaskCount = useMemo<number>(() => {
    if (bucketed === undefined) return 0;
    return bucketed.tasks.reduce((n, t) => (t.status === 'completed' ? n : n + 1), 0);
  }, [bucketed]);

  return { attemptElapsedMs, remainingTaskCount };
};
