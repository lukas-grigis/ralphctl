// Retention audit: BOUNDED via `TASK_ROUND_CAP = 500` LRU on insertion order (was UNBOUNDED before
// the cap landed — keyed by stable taskId, so a long sprint with many planned tasks would have
// accumulated entries indefinitely). Each entry is a tiny `{ roundN, totalCap }` pair (~24 bytes),
// so 500 keys × ref overhead is well under 100 KB. Sound because the monotonic guard still runs
// first (no-op on stale events, so they never bump LRU order), and the eviction loop only fires
// on net-new insertions past the cap — mirrors the `use-token-usage.ts` pattern.

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

/**
 * Hard cap on retained per-task round entries. A planner can legitimately emit dozens to low
 * hundreds of tasks per sprint; 500 leaves comfortable headroom while pinning worst-case memory
 * for a runaway sprint or a stuck process that accumulates state across many sessions. Eviction
 * order is insertion (delete + re-set on update so the most recently bumped taskId stays hot),
 * matching the LRU pattern in `use-token-usage.ts`.
 */
export const TASK_ROUND_CAP = 500;

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
    return bus.subscribe((event) => {
      if (!isTaskRoundStarted(event)) return;
      setRounds((prev) => {
        const existing = prev.get(event.taskId);
        // Monotonic guard — late-arriving older rounds (replay, out-of-order delivery) must
        // not regress the high-water mark.
        if (existing !== undefined && existing.roundN >= event.roundN) return prev;
        const next = new Map(prev);
        // Delete + re-set so an updated taskId jumps to the end of insertion order; the LRU
        // eviction below then drops the actually-oldest entry, not whichever taskId hashed
        // first in Map's insertion order.
        next.delete(event.taskId);
        next.set(event.taskId, { roundN: event.roundN, totalCap: event.totalCap });
        while (next.size > TASK_ROUND_CAP) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      });
    });
  }, [bus]);

  return rounds;
};
