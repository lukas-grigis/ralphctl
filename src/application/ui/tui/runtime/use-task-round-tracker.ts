// Retention audit: BOUNDED via `TASK_ROUND_CAP = 500` LRU on insertion order (was UNBOUNDED before
// the cap landed — keyed by stable taskId, so a long sprint with many planned tasks would have
// accumulated entries indefinitely). Each entry is a tiny `{ roundN, totalCap }` pair (~24 bytes),
// so 500 keys × ref overhead is well under 100 KB. Sound because the monotonic guard still runs
// first (no-op on stale events, so they never bump LRU order), and the eviction loop only fires
// on net-new insertions past the cap — mirrors the `use-token-usage.ts` pattern.
//
// Commit-rate: the subscription feeds a `createCoalescedBuffer`, so a burst of `task-round-started`
// events yields at most ONE `setRounds` (one React commit) per flush window rather than one
// per publish — the same commit-storm guard `use-event-bus.ts` gained in d2208392. `TASK_ROUND_CAP`
// doubles as the buffer's per-window event cap; because it equals the Map cap, the buffer can only
// shed events the Map fold would itself evict via LRU, so the dual use never drops a live entry.

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
import { createCoalescedBuffer } from '@src/application/ui/tui/runtime/coalesced-buffer.ts';

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

/** @public */
export interface UseTaskRoundTrackerOptions {
  /** Flush cadence in ms. Test-only escape hatch; production callers use the coalescer default. */
  readonly flushMs?: number;
}

/**
 * Subscribe to `task-round-started` events on `bus` and return the latest round + cap per
 * taskId. The returned Map is a fresh value on every update so React's referential equality
 * check triggers re-renders of consumers that destructure the map.
 *
 * No filter on `chainId` here — the implement chain is sprint-scoped and only one runs at a
 * time per process (the cross-process lock enforces this), so cross-talk between concurrent
 * sessions is structurally impossible. Components that drive multiple sessions still get a
 * single source of truth because the upstream filtering happens at the runner-bridge layer.
 *
 * Events feed a `createCoalescedBuffer` (delta semantics via `clearOnFlush`), so a burst of
 * publishes is folded into the Map in a single `setRounds` per flush window — decoupling the
 * publish rate from React's commit rate. The monotonic guard reads `next ?? prev` so same-taskId
 * events within one batch fold in arrival order; the lazy clone skips the allocation (and the
 * re-render) entirely when every event in a batch is stale.
 */
export const useTaskRoundTracker = (
  bus: EventBus,
  opts: UseTaskRoundTrackerOptions = {}
): ReadonlyMap<string, TaskRound> => {
  const { flushMs } = opts;
  const [rounds, setRounds] = useState<ReadonlyMap<string, TaskRound>>(() => new Map());

  useEffect(() => {
    const buf = createCoalescedBuffer<TaskRoundStartedEvent>({
      limit: TASK_ROUND_CAP,
      clearOnFlush: true,
      ...(flushMs !== undefined ? { flushMs } : {}),
      onFlush: (batch) => {
        setRounds((prev) => {
          let next: Map<string, TaskRound> | undefined;
          for (const event of batch) {
            const existing = (next ?? prev).get(event.taskId);
            // Monotonic guard — a late/older round must not regress the high-water mark.
            if (existing !== undefined && existing.roundN >= event.roundN) continue;
            if (next === undefined) next = new Map(prev);
            // Delete + re-set so an updated taskId jumps to the end of insertion order; the
            // post-fold trim below then drops the actually-oldest entry, not whichever taskId
            // hashed first in Map's insertion order.
            next.delete(event.taskId);
            next.set(event.taskId, { roundN: event.roundN, totalCap: event.totalCap });
          }
          if (next === undefined) return prev;
          // Single LRU trim once the whole batch is folded (delete+set kept order hot per taskId).
          while (next.size > TASK_ROUND_CAP) {
            const oldest = next.keys().next().value;
            if (oldest === undefined) break;
            next.delete(oldest);
          }
          return next;
        });
      },
    });
    const unsub = bus.subscribe((event) => {
      if (isTaskRoundStarted(event)) buf.push(event);
    });
    // Order matters: unsub first so no push can race the drain, flushNow to land in-flight events,
    // stop last to tear down the timer (no flush-after-stop on single-threaded JS).
    return () => {
      unsub();
      buf.flushNow();
      buf.stop();
    };
  }, [bus, flushMs]);

  return rounds;
};
