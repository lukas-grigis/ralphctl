/**
 * Backoff schedule for rate-limit retries in the headless AI adapters.
 *
 * Before: every adapter's retry loop fell through to `continue` immediately. Three retries
 * landed in the same second, so a daily-quota throttle was guaranteed to exhaust the budget
 * inside one round-trip and surface as `RateLimitError`. Useless for unattended runs.
 *
 * After: increasing waits — 1 min → 5 min → 30 min → 2 h — capped at 2 h for any further
 * attempts. The sequence is opinionated: short enough that a per-minute throttle clears
 * before the wait expires, long enough that a daily-quota throttle gets a chance to reset
 * on a fresh window. Tuned for "leave it running overnight" use; tests inject their own
 * schedule via the dep override.
 *
 * `sleepCancellable` short-circuits on `abortSignal` so Ctrl-C / TUI cancel doesn't have to
 * wait two hours for the in-flight retry timer.
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

/**
 * `setTimeout`-backed sleep that resolves early when the caller's abort signal fires. Used
 * by the adapter's retry loop so a user-initiated cancel doesn't have to wait through a
 * multi-hour rate-limit backoff before the chain exits.
 */
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
