/**
 * `waitFor` — poll a predicate until it stops throwing, with a timeout. Replaces the
 * wall-clock `tick(ms)` pattern that was the dominant source of TUI test flakes: under
 * heavy CPU contention from concurrent vitest forks, a literal `await tick(40)` often
 * resolves well after Ink's render queue has actually settled, but a tick budget that's
 * generous enough on a quiet machine then exceeds the per-test timeout on a busy one. A
 * polling waiter sidesteps both directions of that trap — it returns the moment the
 * expected state is observed, and waits no longer than necessary.
 *
 * The check function typically wraps an `expect(...)` so the surfaced error on timeout is
 * the same one a synchronous assertion would have produced — handy for diagnosing real
 * regressions (versus flakes) because the final-attempt error is rethrown unchanged.
 */
export interface WaitForOptions {
  /** Hard ceiling in milliseconds. Default 3000ms — enough headroom for a slow vitest fork
   * without exceeding the default per-test timeout. */
  readonly timeout?: number;
  /** Poll interval in milliseconds. Default 15ms — short enough to feel instant, long
   * enough not to peg the event loop. */
  readonly interval?: number;
}

export const waitFor = async (check: () => void | Promise<void>, opts: WaitForOptions = {}): Promise<void> => {
  const timeout = opts.timeout ?? 3000;
  const interval = opts.interval ?? 15;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  // Try once eagerly so the happy path skips a sleep entirely.
  while (true) {
    try {
      await check();
      // Condition satisfied — yield twice through the macrotask queue so any `useEffect`
      // scheduled during the render we just observed has a chance to run before the caller
      // writes keystrokes. Without this, the next step's `useInput` may not yet be
      // listening when the test pushes a key on stdin, and the key is silently dropped.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
  // Surface the final assertion error so the test failure reads like a normal
  // expectation mismatch rather than an opaque "waitFor timed out".
  throw lastError instanceof Error
    ? lastError
    : new Error(`waitFor: condition never satisfied within ${String(timeout)}ms`);
};
