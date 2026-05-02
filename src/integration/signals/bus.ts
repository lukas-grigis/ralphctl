/**
 * `InMemorySignalBus` — concrete `SignalBusPort` implementation.
 *
 * Coalesces emissions inside a ~16 ms window via the kernel's
 * {@link SignalMicroBatcher}. Subscribers receive events in original
 * emission order, batched per animation-frame to avoid render storms in
 * the live TUI dashboard.
 *
 * Listener exceptions never stall delivery — each invocation is wrapped
 * defensively. Throwing listeners are reported via `console.warn` (the
 * single intentional `console.*` allowance in this module — the bus is
 * pre-logger infrastructure, so injecting a `LoggerPort` here would
 * invert the dependency).
 */
import { SignalMicroBatcher } from '@src/kernel/algorithms/signal-micro-batcher.ts';
import { currentSessionId } from '@src/kernel/runtime/session-context.ts';
import type { SignalBusEvent, SignalBusPort } from '@src/business/ports/signal-bus-port.ts';

const FRAME_MS = 16;

export interface InMemorySignalBusOptions {
  /** Override the coalescing window (defaults to 16ms — one animation frame). */
  readonly intervalMs?: number;
}

export class InMemorySignalBus implements SignalBusPort {
  private readonly listeners = new Set<(event: SignalBusEvent) => void>();
  private readonly batcher: SignalMicroBatcher<SignalBusEvent>;
  private disposed = false;

  constructor(opts: InMemorySignalBusOptions = {}) {
    this.batcher = new SignalMicroBatcher<SignalBusEvent>({
      intervalMs: opts.intervalMs ?? FRAME_MS,
      flush: (batch) => {
        // Deliver in emission order, one event at a time per listener.
        for (const event of batch) {
          for (const listener of this.listeners) {
            try {
              listener(event);
            } catch (err) {
              // A broken subscriber must not stall the bus. Documented
              // single-console allowance — see file header. The bus is
              // pre-logger infrastructure so we cannot route through
              // `LoggerPort` without inverting the dependency.
              console.warn('SignalBus listener threw:', err);
            }
          }
        }
      },
    });
  }

  emit(event: SignalBusEvent): void {
    if (this.disposed) return;
    // Auto-tag with the active chain's session id when emit was called
    // inside a `ChainRunner` ALS scope. Caller-provided sessionId wins —
    // a leaf inside one chain explicitly tagging an event for a different
    // session is rare but legitimate.
    const sid = currentSessionId();
    const tagged: SignalBusEvent =
      sid !== undefined && event.sessionId === undefined ? { ...event, sessionId: sid } : event;
    this.batcher.push(tagged);
  }

  subscribe(listener: (event: SignalBusEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Synchronous flush — drains anything queued so subscribers see every
    // event up to the dispose call before being dropped.
    this.batcher.dispose();
    this.listeners.clear();
  }
}

/** Null-object bus — used when no observers are active (non-TTY, tests). */
export class NoopSignalBus implements SignalBusPort {
  emit(_event: SignalBusEvent): void {
    void _event;
  }
  subscribe(_listener: (event: SignalBusEvent) => void): () => void {
    void _listener;
    return () => undefined;
  }
  dispose(): void {
    /* no-op */
  }
}
