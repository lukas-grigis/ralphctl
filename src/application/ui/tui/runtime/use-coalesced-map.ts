/**
 * Keyed-Map sibling of {@link useCoalescedBuffer} — folds a hot AppEvent subscription into a `Map<key, V>` instead of
 * a trailing array, at most once per flush window.
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
  /** Folds an accepted event into the Map value for its key. */
  readonly fold: (existing: V | undefined, e: E) => V | undefined;
}

/** Subscribe to `accept`-matching events on `bus` and fold them into a `Map<key, V>` via `fold`. */
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
