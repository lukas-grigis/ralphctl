import { passthroughRunInTerminal, type RunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';

/**
 * Module-level holder for the active `runInTerminal`. The TUI bootstrap (`launchTui`) swaps
 * this from the passthrough default to an Ink-aware variant after the Ink instance exists —
 * Ink doesn't expose pause/resume via hooks, so the swap happens out-of-band.
 *
 * Views and the launcher read through {@link useRunInTerminal} which closes over the ref so
 * the binding stays stable across renders.
 */
const ref: { current: RunInTerminal } = { current: passthroughRunInTerminal };

export const setRunInTerminal = (next: RunInTerminal): void => {
  ref.current = next;
};

export const getRunInTerminal = (): RunInTerminal => (fn) => ref.current(fn);
