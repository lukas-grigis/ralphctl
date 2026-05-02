/**
 * Event emitted when the coordinator's pause state changes.
 *
 * `paused` carries the reason and an optional resume timestamp that callers
 * can use to schedule UI countdowns; `resumed` carries no payload because the
 * resume itself is the signal.
 */
export type RateLimitEvent =
  | { readonly type: 'paused'; readonly reason: string; readonly resumeAt?: Date }
  | { readonly type: 'resumed' };

/** Listener callback for {@link RateLimitCoordinator.subscribe}. */
export type RateLimitListener = (event: RateLimitEvent) => void;

interface PausedState {
  readonly type: 'paused';
  readonly reason: string;
  readonly resumeAt?: Date;
}

interface RunningState {
  readonly type: 'running';
}

type CoordinatorState = PausedState | RunningState;

/**
 * Global pause / resume primitive shared across all in-flight tasks.
 *
 * Used by the executor to halt the launching of new tasks when one task hits
 * an upstream rate limit, while letting in-flight tasks complete. Subscribers
 * (UI / log sinks) react to state changes.
 *
 * The class is intentionally tiny: the kernel does not own any retry / sleep
 * policy here. Callers wait for `waitUntilResumed()` and then make their own
 * decision. The coordinator's only job is the pause flag and the broadcast.
 */
export class RateLimitCoordinator {
  private state: CoordinatorState = { type: 'running' };
  private readonly listeners = new Set<RateLimitListener>();
  private readonly waiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
    readonly cleanup: () => void;
  }>();

  /** Whether the coordinator is currently in the paused state. */
  public isPaused(): boolean {
    return this.state.type === 'paused';
  }

  /**
   * Enter (or update) the paused state.
   *
   * Calling `pause()` while already paused REPLACES the reason / resumeAt and
   * re-notifies subscribers — useful when a new rate-limit signal arrives
   * with a fresher resumeAt before the previous pause has been resumed.
   */
  public pause(reason: string, resumeAt?: Date): void {
    this.state = resumeAt ? { type: 'paused', reason, resumeAt } : { type: 'paused', reason };
    this.broadcast({ type: 'paused', reason, ...(resumeAt ? { resumeAt } : {}) });
  }

  /**
   * Leave the paused state and release every waiter. No-op when not paused.
   */
  public resume(): void {
    if (this.state.type !== 'paused') return;
    this.state = { type: 'running' };

    // Drain waiters first so listener side-effects (e.g. logging) see a
    // consistent state when they observe the `resumed` event.
    const waitersSnapshot = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waitersSnapshot) {
      waiter.cleanup();
      waiter.resolve();
    }

    this.broadcast({ type: 'resumed' });
  }

  /**
   * Resolves immediately if not paused; otherwise resolves the next time
   * {@link resume} is called.
   *
   * Honors `signal`: aborting before/while waiting rejects with the signal's
   * reason (or a synthetic abort error when none is set). The waiter is then
   * removed cleanly so a later `resume()` won't try to settle it again.
   */
  public waitUntilResumed(signal?: AbortSignal): Promise<void> {
    if (this.state.type === 'running') return Promise.resolve();

    if (signal?.aborted) {
      // `AbortSignal.reason` is `unknown` by the platform spec — callers may
      // pass plain strings to `controller.abort('reason')`. Forward verbatim
      // so callers can pattern-match on their own reasons. abortReason()
      // guarantees the value is never `undefined`.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(this.abortReason(signal));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        cleanup: (): void => {
          if (signal) signal.removeEventListener('abort', onAbort);
        },
      };
      const onAbort = (): void => {
        this.waiters.delete(waiter);
        waiter.cleanup();
        // See waitUntilResumed() — forwarding the platform-supplied reason.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(this.abortReason(signal));
      };
      this.waiters.add(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Subscribe to pause / resume events. Returns an unsubscribe function.
   *
   * Listeners are invoked synchronously during `pause`/`resume`; one
   * misbehaving listener must not stall delivery to the others. We catch and
   * report — see the inline comment on the catch.
   */
  public subscribe(listener: RateLimitListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(event: RateLimitEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        // The kernel is normally console-silent. This is the one allowed
        // exception: subscribers are user-supplied callbacks and a thrown
        // listener must not stop delivery to the rest of the subscriber set.
        // We surface the failure on stderr (warn) so it's not invisible, but
        // we never rethrow — the coordinator's contract is "broadcast can't
        // stall".
        console.warn('[rate-limit-coordinator] listener threw:', err);
      }
    }
  }

  private abortReason(signal?: AbortSignal): unknown {
    if (signal?.reason !== undefined) return signal.reason;
    return new DOMException('Aborted', 'AbortError');
  }
}
