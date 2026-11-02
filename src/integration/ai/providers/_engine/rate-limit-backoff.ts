/**
 * Backoff for rate-limit retries: 1 min → 5 min → 30 min → 2 h, then 2 h. Short enough for a
 * per-minute throttle to clear, long enough for a daily quota to reset on a fresh window — tuned
 * for unattended overnight runs. `delayForRetry` is pure; callers spread it with {@link applyJitter}.
 */

const ONE_MINUTE = 60_000;
const FIVE_MINUTES = 5 * 60_000;
const THIRTY_MINUTES = 30 * 60_000;
const TWO_HOURS = 2 * 60 * 60_000;

/**
 * Default schedule indexed by retry number (1-based). `delayForRetry(1)` returns the wait
 * BEFORE the 2nd attempt, etc. Past the table length the last entry repeats.
 */
export const DEFAULT_BACKOFF_SCHEDULE: readonly number[] = [ONE_MINUTE, FIVE_MINUTES, THIRTY_MINUTES, TWO_HOURS];

export const delayForRetry = (retryIndex: number, schedule: readonly number[] = DEFAULT_BACKOFF_SCHEDULE): number => {
  if (retryIndex < 1) return 0;
  const clamped = Math.min(retryIndex - 1, schedule.length - 1);
  return schedule[clamped] ?? 0;
};

/** Proportional jitter window applied by {@link applyJitter} — +/- 20% of the base delay. */
export const JITTER_RATIO = 0.2;

/**
 * Spread a base delay by up to {@link JITTER_RATIO} either way, so callers that computed the SAME
 * delay off one shared limit don't retry in lockstep. A non-positive delay passes through.
 */
export const applyJitter = (delayMs: number, random: () => number = Math.random): number => {
  if (delayMs <= 0) return delayMs;
  const spread = delayMs * JITTER_RATIO;
  return Math.round(delayMs - spread + random() * spread * 2);
};

/** Resolves early on abort, so a cancel never waits out a multi-hour backoff. */
export const sleepCancellable = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
