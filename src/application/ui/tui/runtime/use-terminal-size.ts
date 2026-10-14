/**
 * Terminal size + resize handling. This hook listens to SIGWINCH so views relayout cleanly when
 * the user resizes the terminal mid-flight. Ink's own `useWindowSize` is not used because it
 * falls back to the host terminal's size when the stream lacks `rows` (the test harness does).
 */

import { useSyncExternalStore } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

interface SizeStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => TerminalSize;
}

// Ink 8 types stdout as a generic stream; TTY dimensions are read structurally.
const readSize = (stdout: NodeJS.WritableStream): TerminalSize => {
  const tty = stdout as Partial<Pick<NodeJS.WriteStream, 'columns' | 'rows'>>;
  return { columns: tty.columns ?? 80, rows: tty.rows ?? 24 };
};

// One `resize` listener per stream, however many components read the size — a listener per
// consumer trips Node's MaxListeners warning, which prints to stderr over the alt-screen.
const stores = new WeakMap<NodeJS.WritableStream, SizeStore>();

const createSizeStore = (stdout: NodeJS.WritableStream): SizeStore => {
  const listeners = new Set<() => void>();
  let snapshot = readSize(stdout);
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      if (listeners.size === 1) stdout.on('resize', notify);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) stdout.off('resize', notify);
      };
    },
    getSnapshot: () => {
      const next = readSize(stdout);
      if (next.columns !== snapshot.columns || next.rows !== snapshot.rows) snapshot = next;
      return snapshot;
    },
  };
};

const sizeStoreFor = (stdout: NodeJS.WritableStream): SizeStore => {
  const existing = stores.get(stdout);
  if (existing) return existing;
  const store = createSizeStore(stdout);
  stores.set(stdout, store);
  return store;
};

export const useTerminalSize = (): TerminalSize => {
  const { stdout } = useStdout();
  const store = sizeStoreFor(stdout);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
};
