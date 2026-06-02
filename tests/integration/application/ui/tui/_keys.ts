/**
 * Special-key byte sequences ink-testing-library expects on stdin. Kept in one module so the
 * literal escape characters survive editor round-trips intact (some tooling silently strips
 * raw \x1b from .tsx files).
 */

export const ENTER = '\r';
export const ESC = '';
export const UP = '[A';
export const DOWN = '[B';
export const RIGHT = '[C';
export const LEFT = '[D';
export const HOME = '[H';
export const END = '[F';
export const CTRL_A = '';
export const CTRL_E = '';
export const CTRL_J = '\n';
export const CTRL_U = '';
export const CTRL_W = '';

// PageUp / PageDown — xterm CSI sequences Ink parses as key.pageUp / key.pageDown. Built from
// String.fromCharCode(27) so the ESC byte survives editor round-trips without a raw control char.
export const PAGE_UP = `${String.fromCharCode(27)}[5~`;
export const PAGE_DOWN = `${String.fromCharCode(27)}[6~`;

/**
 * Yield long enough for Ink's escape-sequence disambiguation timeout (~10ms) and a microtask
 * flush. The default is enough for state-flushing; longer for ESC where we wait for the timer.
 */
export const tick = async (ms = 30): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Poll `predicate` until it returns true or `timeoutMs` elapses. Use this in place of a fixed
 * `tick(N)` when the test depends on an async settling step whose timing isn't bounded by a
 * single Ink render tick — e.g. waiting for a stubbed repo `findById` to resolve before the
 * view's `useInput` handler is responsive, or waiting for an async `openEditPrompt` to enqueue
 * a prompt after a keystroke. Cheap on the happy path (~10ms first poll), bounded on cold CI.
 */
export const waitFor = async (
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> => {
  const { timeoutMs = 1000, intervalMs = 10 } = opts;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) return;
    await tick(intervalMs);
  }
};
