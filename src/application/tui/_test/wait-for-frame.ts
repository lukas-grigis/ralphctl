import { vi } from 'vitest';

/**
 * Poll `lastFrame()` until `predicate` returns true, using `vi.waitFor` so
 * the test runner retries on Ink's async render schedule instead of relying on
 * a fixed `setTimeout` delay that races under heavy parallel CI load.
 *
 * The function throws with `opts.reason` if the frame does not satisfy the
 * predicate within `opts.timeoutMs` (default 1500 ms).
 *
 * Usage:
 *   await waitForFrame(lastFrame, (f) => f.includes('Pipeline Sprint'),
 *     { reason: 'expected sprint name in home view' });
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; reason?: string } = {}
): Promise<void> {
  const timeout = opts.timeoutMs ?? 1500;
  const interval = opts.intervalMs ?? 16;
  await vi.waitFor(
    () => {
      const frame = lastFrame() ?? '';
      if (!predicate(frame)) {
        throw new Error(opts.reason ?? `frame did not match predicate within ${String(timeout)}ms`);
      }
    },
    { timeout, interval }
  );
}
