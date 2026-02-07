/**
 * Coordinates rate limit pausing across parallel task executions.
 *
 * When any task hits a rate limit, the coordinator pauses new task launches
 * globally until the cooldown expires. Running tasks continue uninterrupted.
 */
export class RateLimitCoordinator {
  private resumeAt: number | null = null;
  private waiters: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onPauseCallback?: (delayMs: number) => void;
  private onResumeCallback?: () => void;

  constructor(options?: { onPause?: (delayMs: number) => void; onResume?: () => void }) {
    this.onPauseCallback = options?.onPause;
    this.onResumeCallback = options?.onResume;
  }

  /** Whether the coordinator is currently paused due to a rate limit. */
  get isPaused(): boolean {
    return this.resumeAt !== null && Date.now() < this.resumeAt;
  }

  /** Milliseconds remaining until resume, or 0 if not paused. */
  get remainingMs(): number {
    if (this.resumeAt === null) return 0;
    return Math.max(0, this.resumeAt - Date.now());
  }

  /**
   * Pause new task launches for a given duration.
   * If already paused, extends the pause if the new duration is longer.
   */
  pause(delayMs: number): void {
    const newResumeAt = Date.now() + delayMs;

    // Only extend, never shorten an existing pause
    if (this.resumeAt !== null && newResumeAt <= this.resumeAt) {
      return;
    }

    this.resumeAt = newResumeAt;

    // Clear existing timer and set a new one
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }

    this.onPauseCallback?.(delayMs);

    this.timer = setTimeout(() => {
      this.resume();
    }, delayMs);
  }

  /**
   * Wait until the rate limit pause is lifted.
   * Returns immediately if not paused.
   */
  async waitIfPaused(): Promise<void> {
    if (!this.isPaused) return;

    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Clean up timers. Call when execution is complete.
   */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resume();
  }

  private resume(): void {
    this.resumeAt = null;
    this.timer = null;
    this.onResumeCallback?.();
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
