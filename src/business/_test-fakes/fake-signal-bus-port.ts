/**
 * `FakeSignalBusPort` — non-IO fake of {@link SignalBusPort} for use-case
 * unit tests.
 *
 * Captures every emitted event in `events` for assertion convenience and
 * delivers events synchronously to subscribers (no micro-batching). Tests
 * that need to assert "the use case emitted a `task-complete` signal" can
 * inspect `events` directly.
 */
import type { SignalBusEvent, SignalBusPort } from '@src/business/ports/signal-bus-port.ts';

export class FakeSignalBusPort implements SignalBusPort {
  readonly events: SignalBusEvent[] = [];
  private readonly listeners = new Set<(event: SignalBusEvent) => void>();
  private disposed = false;

  emit(event: SignalBusEvent): void {
    if (this.disposed) return;
    this.events.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Match real bus contract: a thrown listener never stalls others.
      }
    }
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
    this.listeners.clear();
  }
}
