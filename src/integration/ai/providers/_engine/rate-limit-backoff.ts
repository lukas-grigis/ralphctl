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
 *
 * `delayForRetry` stays a pure function of `retryIndex` — two branches at the same retry index
 * get the identical base delay by design (that's what the "matches the documented 1m → 5m →
 * 30m → 2h sequence" test pins). {@link applyJitter} is the paired primitive a caller applies to
 * that base delay before sleeping, so concurrent parallel branches sharing one account-level
 * rate limit disperse their wake times instead of retrying in lockstep and re-tripping the same
 * limit their synchronized burst of 429s just hit.
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
 * Spread a base delay by up to {@link JITTER_RATIO} in either direction so concurrent callers
 * that computed the SAME base delay (e.g. several parallel branches hitting the same
 * account-level rate limit at essentially the same instant) don't wake and retry in lockstep.
 *
 * `random` is an injectable `[0, 1)` source, defaulting to `Math.random` — tests pin a fake
 * (e.g. `() => 0`, `() => 0.999999`) to assert the exact jittered bound instead of asserting on
 * live randomness. `delayMs <= 0` (the "no wait" sentinel `delayForRetry` returns past the
 * defensive `retryIndex < 1` guard) passes through unchanged — there is nothing to disperse.
 */
export const applyJitter = (delayMs: number, random: () => number = Math.random): number => {
  if (delayMs <= 0) return delayMs;
  const spread = delayMs * JITTER_RATIO;
  return Math.round(delayMs - spread + random() * spread * 2);
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
