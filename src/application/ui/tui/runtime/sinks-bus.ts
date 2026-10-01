/**
 * Subscribable sink — extends the business `Sink<T>` port with an inspectable buffer and a fan-out subscription.
 */

import type { Sink } from '@src/business/observability/sink.ts';

export interface BusSink<T> extends Sink<T> {
  /** Snapshot of every value emitted so far, in emission order. Read-only. */
  readonly entries: readonly T[];
  /** Number of currently-attached subscribers. Useful for tests / debugging. */
  readonly subscriberCount: number;

  /** Register a listener; returns an unsubscribe function. */
  subscribe(fn: (value: T) => void): () => void;

  /** Drop the buffered entries. Subscribers stay attached. */
  clear(): void;
}

export interface CreateBusSinkOptions {
  /** Cap on retained entries. Older entries are dropped when the buffer overflows. */
  readonly maxEntries?: number;
}

/** Construct a bus-style sink. Order of operations on `emit`: 1. */
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
