import { passthroughRunInTerminal, type RunInTerminal } from '@src/application/ui/shared/run-in-terminal.ts';

/** Module-level holder for the active `runInTerminal`. */
const ref: { current: RunInTerminal } = { current: passthroughRunInTerminal };

export const setRunInTerminal = (next: RunInTerminal): void => {
  ref.current = next;
};

export const getRunInTerminal = (): RunInTerminal => (fn) => ref.current(fn);
