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

/**
 * Yield long enough for Ink's escape-sequence disambiguation timeout (~10ms) and a microtask
 * flush. The default is enough for state-flushing; longer for ESC where we wait for the timer.
 */
export const tick = async (ms = 30): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
