/**
 * Registers Ink's `suspendTerminal` as the live `runInTerminal` implementation.
 *
 * `suspendTerminal` is the API Ink documents for `$EDITOR` / `less` / nested TUIs: raw mode off,
 * kitty off, alt-screen exited, Ink writes flushed then paused, and all of it restored after the
 * child exits — with the React tree left mounted throughout. The host's unmount/remount fallback
 * tears the tree down instead and is only reachable before `App` mounts.
 *
 * {@link releaseTerminalForChild} runs inside the suspension for the modes Ink never set and so
 * cannot restore — mouse reporting above all, which otherwise floods the child's stdin with CSI
 * sequences. It deliberately leaves `process.stdin` to Ink's own pause/resume pair.
 */

import { useLayoutEffect } from 'react';
import { useApp } from 'ink';
import { releaseTerminalForChild } from '@src/application/ui/shared/release-terminal-for-child.ts';
import { setRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';

export const TerminalHandoff = (): null => {
  const { suspendTerminal } = useApp();
  useLayoutEffect(() => {
    const previous = setRunInTerminal(async <T,>(fn: () => Promise<T>): Promise<T> => {
      const box: { value?: T } = {};
      await suspendTerminal(async () => {
        releaseTerminalForChild();
        box.value = await fn();
      });
      return box.value as T;
    });
    return () => {
      setRunInTerminal(previous);
    };
  }, [suspendTerminal]);
  return null;
};
