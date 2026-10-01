/** Terminal size + resize handling. */

import { useSyncExternalStore } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const readSize = (stdout: NodeJS.WriteStream | undefined): TerminalSize => ({
  columns: stdout?.columns ?? 80,
  rows: stdout?.rows ?? 24,
});

interface SizeStore {
  snapshot: TerminalSize;
  readonly subscribers: Set<() => void>;
  /** The one `'resize'` listener on the stream, present while anyone is subscribed. */
  listener: (() => void) | undefined;
}

const stores = new WeakMap<NodeJS.WriteStream, SizeStore>();

const storeFor = (stdout: NodeJS.WriteStream): SizeStore => {
  let store = stores.get(stdout);
  if (store === undefined) {
    store = { snapshot: readSize(stdout), subscribers: new Set(), listener: undefined };
    stores.set(stdout, store);
  }
  return store;
};

/** Cached object while the size is unchanged, so `useSyncExternalStore` sees a stable snapshot. */
const currentSize = (stdout: NodeJS.WriteStream): TerminalSize => {
  const store = storeFor(stdout);
  const next = readSize(stdout);
  if (next.columns !== store.snapshot.columns || next.rows !== store.snapshot.rows) store.snapshot = next;
  return store.snapshot;
};

const subscribeTo =
  (stdout: NodeJS.WriteStream) =>
  (notify: () => void): (() => void) => {
    const store = storeFor(stdout);
    if (store.listener === undefined) {
      const listener = (): void => {
        const before = store.snapshot;
        if (currentSize(stdout) === before) return;
        for (const fn of [...store.subscribers]) fn();
      };
      store.listener = listener;
      stdout.on('resize', listener);
    }
    store.subscribers.add(notify);
    return () => {
      store.subscribers.delete(notify);
      if (store.subscribers.size === 0 && store.listener !== undefined) {
        stdout.off('resize', store.listener);
        store.listener = undefined;
      }
    };
  };

const FALLBACK: TerminalSize = { columns: 80, rows: 24 };

export const useTerminalSize = (): TerminalSize => {
  const { stdout } = useStdout();
  return useSyncExternalStore(stdout === undefined ? () => () => undefined : subscribeTo(stdout), () =>
    stdout === undefined ? FALLBACK : currentSize(stdout)
  );
};
