/**
 * Registers Ink's `suspendTerminal` as the live `runInTerminal` implementation.
 *
 * Full unmount/remount (the host fallback) exits the alternate screen and disables kitty
 * keyboard protocol, but it does not pause input the way Ink's supported handoff does —
 * Grok's pager then dies during TUI init (`Device not configured` / no `pager started`).
 * `suspendTerminal` is the API Ink documents for `$EDITOR` / `less` / nested TUIs: raw mode
 * off, kitty off, alt-screen exited, Ink writes paused, then restored after the child exits.
 */

import { useLayoutEffect } from 'react';
import { useApp } from 'ink';
import { setRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';

export const TerminalHandoff = (): null => {
  const { suspendTerminal } = useApp();
  useLayoutEffect(() => {
    const previous = setRunInTerminal(async <T,>(fn: () => Promise<T>): Promise<T> => {
      const box: { value?: T } = {};
      await suspendTerminal(async () => {
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
