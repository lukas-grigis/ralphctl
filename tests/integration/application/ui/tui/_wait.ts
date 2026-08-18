/**
 * The TUI suite's two async waiters. Both live here, under DISTINCT names, because they used to
 * be two same-named `waitFor` exports in two modules with OPPOSITE timeout contracts — the
 * `_keys.ts` one returned silently on expiry, so a test whose wait never came true carried on and
 * asserted against whatever the frame happened to hold (or, when the wait WAS the assertion,
 * passed vacuously). A timeout must always fail the test loudly:
 *
 *  - {@link waitFor}          — assertion form. Poll a check that throws (typically an `expect`)
 *                               until it stops throwing; rethrows the last error on expiry.
 *  - {@link waitForPredicate} — boolean form. Poll a predicate until it returns true; throws a
 *                               named error on expiry.
 *
 * Both share the same ceiling, poll interval and post-condition settle, so the choice between
 * them is purely about which callback shape reads better at the call site.
 */

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

/**
 * `waitForPredicate` — the boolean-returning sibling of {@link waitFor}. Use it in place of a
 * fixed `tick(N)` when the test depends on an async settling step whose timing isn't bounded by a
 * single Ink render tick — e.g. waiting for a stubbed repo `findById` to resolve before the view's
 * `useInput` handler is responsive, or waiting for an async `openEditPrompt` to enqueue a prompt
 * after a keystroke.
 *
 * Expiry THROWS. Nothing downstream of a wait that never came true is trustworthy: the frame is
 * still in its pre-settle state, so every following assertion is either misleading (it fails on
 * the wrong thing) or vacuous (the wait was the only check). Naming the predicate that never went
 * true is the useful failure — pass a `label` when the arrow alone won't identify it.
 *
 * Cheap on the happy path (evaluated once before the first sleep), bounded on cold CI.
 */
export const waitForPredicate = async (
  predicate: () => boolean,
  opts: WaitForOptions & { readonly label?: string } = {}
): Promise<void> => {
  const label = opts.label;
  await waitFor(() => {
    if (!predicate()) {
      throw new Error(
        `waitForPredicate: ${label ?? 'predicate'} never became true within ${String(opts.timeout ?? 3000)}ms`
      );
    }
  }, opts);
};
