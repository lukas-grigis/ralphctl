/** Configuration for {@link SignalMicroBatcher}. */
export interface SignalMicroBatcherOptions<T> {
  /**
   * Window during which `push()` calls are coalesced. Typical value: 16 ms,
   * one animation frame, which is small enough to feel live but large enough
   * to absorb signal storms from a chatty AI session.
   */
  readonly intervalMs: number;
  /**
   * Drain function. Called with every item pushed since the last flush, in
   * push order. Never called with an empty batch.
   */
  readonly flush: (batch: readonly T[]) => void;
}

/**
 * Time-windowed coalescer for high-rate event streams.
 *
 * The first `push()` schedules `flush()` for `intervalMs` later; every
 * subsequent `push()` within that window joins the same batch. When the
 * window elapses the batch is delivered in one call, and the next `push()`
 * starts a fresh window.
 *
 * `flushNow()` drains immediately and resets the timer so a quiescent batcher
 * doesn't have a stale scheduled flush hanging around.
 *
 * `dispose()` cancels the timer, drains anything still queued, and prevents
 * any further drains — subsequent `push()` calls are silently dropped. This
 * is a deliberate choice: `dispose()` exists so that after teardown there are
 * no surprise callbacks. The batcher cannot be revived after dispose.
 */
export class SignalMicroBatcher<T> {
  private readonly intervalMs: number;
  private readonly flushFn: (batch: readonly T[]) => void;
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: SignalMicroBatcherOptions<T>) {
    this.intervalMs = opts.intervalMs;
    this.flushFn = opts.flush;
  }

  /** Add an item to the current batch. No-op once disposed. */
  public push(item: T): void {
    if (this.disposed) return;
    this.buffer.push(item);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.drain();
    }, this.intervalMs);
  }

  /**
   * Synchronous flush. Drains the current batch immediately and resets the
   * window so the next `push()` schedules a fresh timer.
   */
  public flushNow(): void {
    if (this.disposed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.drain();
  }

  /**
   * Stop the batcher and drain any pending items synchronously. Idempotent;
   * after the first call, every method becomes a no-op.
   */
  public dispose(): void {
    if (this.disposed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.drain();
    this.disposed = true;
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.flushFn(batch);
  }
}
