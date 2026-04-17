/**
 * Port for coordinating rate-limit pauses across parallel task executions.
 *
 * When any task hits a rate limit (e.g. a `SpawnError` with `rateLimited`
 * set), the coordinator pauses new task launches globally until the cooldown
 * expires. Running tasks continue uninterrupted.
 *
 * The concrete implementation (`src/integration/ai/rate-limiter.ts`)
 * structurally satisfies this interface — business-layer consumers
 * (the pipeline framework, use cases) depend only on this port so the
 * layering (domain < business < integration) is preserved.
 */
export interface RateLimitCoordinatorPort {
  /** Whether the coordinator is currently paused due to a rate limit. */
  readonly isPaused: boolean;

  /** Milliseconds remaining until resume, or 0 if not paused. */
  readonly remainingMs: number;

  /**
   * Pause new task launches for a given duration.
   * If already paused, extends the pause if the new duration is longer.
   */
  pause(delayMs: number): void;

  /**
   * Wait until the rate-limit pause is lifted.
   * Returns immediately if not paused.
   */
  waitIfPaused(): Promise<void>;

  /** Clean up timers / subscribers. Call when execution is complete. */
  dispose(): void;
}
