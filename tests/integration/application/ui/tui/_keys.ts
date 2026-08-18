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

// Async waiters live in `_wait.ts` (`waitFor` / `waitForPredicate`) — this module is key bytes
// plus `tick` only. A silent-on-timeout `waitFor` used to live here as well, under the same name
// as `_wait.ts`'s throwing one; see the `_wait.ts` docstring for why that had to go.
