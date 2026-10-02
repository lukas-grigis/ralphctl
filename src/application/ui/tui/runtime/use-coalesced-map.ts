/**
 * Keyed-Map sibling of {@link useCoalescedBuffer} — folds a hot AppEvent subscription into a
 * `Map<key, V>` instead of a trailing array, at most once per flush window.
 *
 * Owns only the mechanical plumbing shared by every per-key AppEvent tracker: buffer
 * construction, the lazy-clone fold-then-trim reducer, and unsub->flushNow->stop cleanup. The
 * accept predicate, keying, per-event fold, and cap are all caller-supplied — retention rationale
 * and audit docs stay in each caller's own hook file (`use-token-usage.ts`,
 * `use-task-round-tracker.ts`, …).
 *
 * Within-batch threading: `existing` is looked up via `(next ?? prev).get(key)` BEFORE `fold`
 * runs, so a later same-key event in the batch sees the value an earlier one in the same batch
 * just folded — not the pre-batch state. Lazy-clone: `next` is only allocated once some event's
 * `fold` returns non-`undefined`; if every event in a batch is skipped (fold returns `undefined`
 * for all of them), `prev` is returned unchanged and no re-render happens.
 */

import { useEffect, useState } from 'react';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { createCoalescedBuffer } from '@src/application/ui/tui/runtime/coalesced-buffer.ts';

/** @public */
export interface UseCoalescedMapOptions<E extends AppEvent, V> {
  /** Hard cap on retained Map entries — also doubles as the coalescing buffer's per-window cap. */
  readonly cap: number;
  /** Flush cadence in ms. Test-only escape hatch; production callers use the coalescer default. */
  readonly flushMs?: number;
  /** Narrows the bus's `AppEvent` union to the events this tracker folds. */
  readonly accept: (e: AppEvent) => e is E;
  /** Derives the Map key for an accepted event. */
  readonly keyOf: (e: E) => string;
  /**
   * Folds an accepted event into the Map value for its key. Return `undefined` to skip the event
   * (e.g. a stale/out-of-order update) — the existing entry, if any, is left untouched.
   */
  readonly fold: (existing: V | undefined, e: E) => V | undefined;
}

/**
 * Subscribe to `accept`-matching events on `bus` and fold them into a `Map<key, V>` via `fold`.
 * Returns a fresh Map on every update so React's referential equality check triggers re-renders.
 *
 * Events feed a `createCoalescedBuffer` (delta semantics via `clearOnFlush`), so a burst of
 * publishes folds into the Map in a single `setState` per flush window — decoupling the publish
 * rate from React's commit rate.
 */
export const useCoalescedMap = <E extends AppEvent, V>(
  bus: EventBus,
  opts: UseCoalescedMapOptions<E, V>
): ReadonlyMap<string, V> => {
  const { cap, flushMs, accept, keyOf, fold } = opts;
  const [state, setState] = useState<ReadonlyMap<string, V>>(() => new Map());

  useEffect(() => {
    const buf = createCoalescedBuffer<E>({
      limit: cap,
      clearOnFlush: true,
      ...(flushMs !== undefined ? { flushMs } : {}),
      onFlush: (batch) => {
        setState((prev) => {
          let next: Map<string, V> | undefined;
          for (const event of batch) {
            const key = keyOf(event);
            const existing = (next ?? prev).get(key);
            const folded = fold(existing, event);
            if (folded === undefined) continue;
            if (next === undefined) next = new Map(prev);
            // Delete + re-set so an updated key jumps to the end of insertion order; the
            // post-fold trim below then drops the actually-oldest entry, not whichever key
            // hashed first in Map's insertion order.
            next.delete(key);
            next.set(key, folded);
          }
          if (next === undefined) return prev;
          // Single LRU trim once the whole batch is folded (delete+set kept order hot per key).
          while (next.size > cap) {
            const oldest = next.keys().next().value;
            if (oldest === undefined) break;
            next.delete(oldest);
          }
          return next;
        });
      },
    });
    const unsub = bus.subscribe((event) => {
      if (accept(event)) buf.push(event);
    });
    // Order matters: unsub first so no push can race the drain, flushNow to land in-flight events,
    // stop last to tear down the timer (no flush-after-stop on single-threaded JS).
    return () => {
      unsub();
      buf.flushNow();
      buf.stop();
    };
  }, [bus, cap, flushMs, accept, keyOf, fold]);

  return state;
};
