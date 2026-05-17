/**
 * Subscribable sink — extends the business `Sink<T>` port with an inspectable buffer and a
 * fan-out subscription. The TUI uses one of these for harness signals and one for log events
 * so panels can both render the live tail and read a snapshot of past values.
 *
 * This is a TUI-side concern (not in `integration/observability/sinks/`) because it adds a
 * UI-only subscribe seam — the production sink stays the simple `emit`-only contract on the wire.
 */

import type { Sink } from '@src/business/observability/sink.ts';

export interface BusSink<T> extends Sink<T> {
  /** Snapshot of every value emitted so far, in emission order. Read-only. */
  readonly entries: readonly T[];
  /** Register a listener; returns an unsubscribe function. */
  subscribe(fn: (value: T) => void): () => void;
  /** Drop the buffered entries. Subscribers stay attached. */
  clear(): void;
  /** Number of currently-attached subscribers. Useful for tests / debugging. */
  readonly subscriberCount: number;
}

export interface CreateBusSinkOptions {
  /**
   * Cap on retained entries. Older entries are dropped when the buffer overflows. Subscribers
   * still receive every emitted value (the cap only bounds {@link BusSink.entries}).
   * Default: `1000`.
   */
  readonly maxEntries?: number;
}

/**
 * Construct a bus-style sink. Order of operations on `emit`:
 *  1. Append to the rolling buffer (oldest entry dropped if it overflows `maxEntries`).
 *  2. Fan out to subscribers — a thrown listener is logged via `console.warn` and never stalls
 *     delivery to the rest of the set.
 */
export const createBusSink = <T>(opts: CreateBusSinkOptions = {}): BusSink<T> => {
  const max = opts.maxEntries ?? 1000;
  const buf: T[] = [];
  const listeners = new Set<(v: T) => void>();

  return {
    emit(value: T): void {
      buf.push(value);
      if (buf.length > max) buf.splice(0, buf.length - max);
      for (const fn of [...listeners]) {
        try {
          fn(value);
        } catch (err) {
          console.warn('[bus-sink] listener threw:', err);
        }
      }
    },
    subscribe(fn: (value: T) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    clear(): void {
      buf.length = 0;
    },
    get entries(): readonly T[] {
      return buf;
    },
    get subscriberCount(): number {
      return listeners.size;
    },
  };
};
