// Retention audit: BOUNDED via `TASK_ROUND_CAP = 500` LRU on insertion order (was UNBOUNDED before the cap landed —
// keyed by stable taskId.

/**
 * Per-task gen-eval round tracker — subscribes to `task-round-started` AppEvents and folds them into a Map<taskId, {
 * roundN, totalCap }> indexed by taskId.
 */

import type { AppEvent, TaskRoundStartedEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { useCoalescedMap } from '@src/application/ui/tui/runtime/use-coalesced-map.ts';

/** Hard cap on retained per-task round entries. */
export const TASK_ROUND_CAP = 500;

export interface TaskRound {
  /** Monotonic GLOBAL round across the whole task (the `rounds/<N>/` dir is attempt-shared). */
  readonly roundN: number;
  /** Per-ATTEMPT cap (`maxTurns`). */
  readonly totalCap: number;
  /** 1-indexed attempt this round belongs to — the authoritative value straight off the event. */
  readonly attemptN: number;
  /**
   * 1-indexed round WITHIN {@link attemptN}, derived from the attempt boundary rather than the global counter.
   */
  readonly roundInAttempt: number;
}

const isTaskRoundStarted = (e: AppEvent): e is TaskRoundStartedEvent => e.type === 'task-round-started';

// Module-scoped so it stays referentially stable across renders — `useCoalescedMap`'s effect
// deps include it, and a fresh arrow per render would churn the subscription.
const keyOfTaskRound = (e: TaskRoundStartedEvent): string => e.taskId;

// Monotonic guard + attempt-relative round derivation. A late/older round returns `undefined` (skip, leave `existing`
// untouched).
const foldTaskRound = (existing: TaskRound | undefined, e: TaskRoundStartedEvent): TaskRound | undefined => {
  if (existing && existing.roundN >= e.roundN) return undefined;
  const attemptStartRoundN =
    existing === undefined || e.attemptN !== existing.attemptN
      ? e.roundN
      : existing.roundN - existing.roundInAttempt + 1;
  return {
    roundN: e.roundN,
    totalCap: e.totalCap,
    attemptN: e.attemptN,
    roundInAttempt: e.roundN - attemptStartRoundN + 1,
  };
};

/** @public */
export interface UseTaskRoundTrackerOptions {
  /** Flush cadence in ms. Test-only escape hatch; production callers use the coalescer default. */
  readonly flushMs?: number;
}

/** Subscribe to `task-round-started` events on `bus` and return the latest round + cap per taskId. */
export const useTaskRoundTracker = (
  bus: EventBus,
  opts: UseTaskRoundTrackerOptions = {}
): ReadonlyMap<string, TaskRound> =>
  useCoalescedMap<TaskRoundStartedEvent, TaskRound>(bus, {
    cap: TASK_ROUND_CAP,
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    accept: isTaskRoundStarted,
    keyOf: keyOfTaskRound,
    fold: foldTaskRound,
  });
