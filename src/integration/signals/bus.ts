/**
 * In-memory signal bus with per-frame coalescing.
 *
 * Subscribers receive batches of events drained from a buffer on each animation
 * tick (≈16ms). This lets high-volume signal emission (e.g. AI streaming output)
 * avoid triggering one React render per signal.
 *
 * Not thread-safe — single Node.js event loop only.
 */

import type { HarnessEvent, SignalBusPort, Unsubscribe } from '@src/business/ports/signal-bus.ts';

const FRAME_MS = 16;

export interface InMemorySignalBusOptions {
  /** Override the coalescing window (defaults to 16ms, one animation frame). */
  flushIntervalMs?: number;
}

export class InMemorySignalBus implements SignalBusPort {
  private readonly listeners = new Set<(events: readonly HarnessEvent[]) => void>();
  private readonly buffer: HarnessEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;
  private disposed = false;

  constructor(options: InMemorySignalBusOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? FRAME_MS;
  }

  emit(event: HarnessEvent): void {
    if (this.disposed) return;
    this.buffer.push(event);
    this.scheduleFlush();
  }

  subscribe(listener: (events: readonly HarnessEvent[]) => void): Unsubscribe {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.listeners.clear();
    this.buffer.length = 0;
  }

  /** Flush buffered events immediately. Primarily for tests. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.drain();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      this.drain();
    }, this.flushIntervalMs);
    // Allow Node.js to exit while this timer is pending.
    timer.unref();
    this.flushTimer = timer;
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    for (const listener of this.listeners) {
      try {
        listener(batch);
      } catch {
        // Swallow listener errors — a broken subscriber must not stall the bus.
      }
    }
  }
}

/** Null-object signal bus used when no subscribers are active (non-TTY, tests). */
export class NoopSignalBus implements SignalBusPort {
  emit(_event: HarnessEvent): void {
    void _event;
  }
  subscribe(_listener: (events: readonly HarnessEvent[]) => void): Unsubscribe {
    void _listener;
    return () => undefined;
  }
  dispose(): void {
    /* no-op */
  }
}
