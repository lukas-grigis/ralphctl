import { passthroughRunInTerminal, type RunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';

/**
 * Module-level holder for the active `runInTerminal`. The TUI bootstrap (`launchTui`) installs
 * the host's unmount-based fallback; {@link TerminalHandoff} then swaps in Ink's
 * `suspendTerminal` (the supported child-process handoff) once the React tree is mounted.
 * Views and the launcher read through {@link getRunInTerminal}, which closes over the ref so
 * the binding stays stable across renders.
 */
const ref: { current: RunInTerminal } = { current: passthroughRunInTerminal };

/** Install `next` and return the previous handler so callers can restore on unmount. */
export const setRunInTerminal = (next: RunInTerminal): RunInTerminal => {
  const previous = ref.current;
  ref.current = next;
  return previous;
};

export const getRunInTerminal = (): RunInTerminal => (fn) => ref.current(fn);
