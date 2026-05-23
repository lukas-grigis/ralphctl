/**
 * Per-task gen-eval round tracker — subscribes to `task-round-started` AppEvents and folds
 * them into a Map<taskId, { roundN, totalCap }> indexed by taskId. The latest round per task
 * wins (events are monotonic — `roundN` is strictly increasing within an attempt).
 *
 * Why this is needed: the chain `trace` is a ring buffer (see `MAX_TRACE_ENTRIES` in
 * `chain/run/runner.ts`); counting `generator-<taskId>` trace entries silently undercounts
 * once early entries get evicted. The `task-round-started` event is the authoritative source
 * — emitted once at the start of every round before the corresponding generator leaf runs,
 * so even if the trace forgets, the latest event for a task still names the current round.
 *
 * The hook filters by `sessionId` (the runner id) via the bus's `chainId`-bearing events.
 * Each `task-round-started` event carries `taskId` directly, so we don't need windowing.
 */

import { useEffect, useState } from 'react';
import type { AppEvent, TaskRoundStartedEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

export interface TaskRound {
  readonly roundN: number;
  readonly totalCap: number;
}

const isTaskRoundStarted = (e: AppEvent): e is TaskRoundStartedEvent => e.type === 'task-round-started';

/**
 * Subscribe to `task-round-started` events on `bus` and return the latest round + cap per
 * taskId. The returned Map is a fresh value on every update so React's referential equality
 * check triggers re-renders of consumers that destructure the map.
 *
 * No filter on `chainId` here — the implement chain is sprint-scoped and only one runs at a
 * time per process (the cross-process lock enforces this), so cross-talk between concurrent
 * sessions is structurally impossible. Components that drive multiple sessions still get a
 * single source of truth because the upstream filtering happens at the runner-bridge layer.
 */
export const useTaskRoundTracker = (bus: EventBus): ReadonlyMap<string, TaskRound> => {
  const [rounds, setRounds] = useState<ReadonlyMap<string, TaskRound>>(() => new Map());

  useEffect(() => {
    const unsub = bus.subscribe((event) => {
      if (!isTaskRoundStarted(event)) return;
      setRounds((prev) => {
        const existing = prev.get(event.taskId);
        // Monotonic guard — late-arriving older rounds (replay, out-of-order delivery) must
        // not regress the high-water mark.
        if (existing !== undefined && existing.roundN >= event.roundN) return prev;
        const next = new Map(prev);
        next.set(event.taskId, { roundN: event.roundN, totalCap: event.totalCap });
        return next;
      });
    });
    return unsub;
  }, [bus]);

  return rounds;
};
