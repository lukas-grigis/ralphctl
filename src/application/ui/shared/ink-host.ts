/**
 * Ink-aware launcher host. Owns the live Ink instance and the "pause" semantics used when
 * an interactive AI session needs to take over the terminal.
 *
 * Lifecycle:
 *   - `render()` is called with `alternateScreen: true` so the wordmark + chrome appear on a
 *     fresh buffer; on unmount Ink automatically restores the user's original screen.
 *   - `runInTerminal(fn)` performs a *real* unmount before invoking `fn`: the React tree is
 *     torn down, the alternate screen is exited, and `fn` runs against the user's primary
 *     terminal. When `fn` resolves we re-`render()` the same App element (a fresh tree, the
 *     stateful TUI gets re-mounted from scratch).
 *   - `waitForShutdown()` keeps the launcher alive across these pause/resume cycles. Each
 *     pause unmounts the current Ink instance, which would normally resolve
 *     `waitUntilExit()` and let the process drop the TUI; the host loop instead checks
 *     whether a pause is in flight and re-awaits the next instance.
 *
 * Why a full unmount rather than `instance.clear()`: while `fn` runs the user owns the
 * terminal. If we left the React tree mounted, any bus/state update would cause Ink to
 * write to stdout and clobber the AI session's UI. Tearing the tree down severs every
 * subscription cleanly.
 */
import type { ReactElement } from 'react';
import { type Instance as InkInstance, render } from 'ink';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';

export interface InkHostDeps {
  readonly appElement: ReactElement;
  /**
   * Override whether Ink uses the terminal's alternate-screen buffer. Defaults to `true` so
   * starting ralphctl gives the operator a clean screen and exiting restores their scrollback.
   */
  readonly alternateScreen?: boolean;
}

export interface InkHost {
  readonly runInTerminal: RunInTerminal;
  /**
   * Resolves when the user truly quits the TUI (Ctrl-C / `q` / a fatal error). Pauses for AI
   * sessions are transparent — they unmount and remount the Ink instance, but this promise
   * does not resolve.
   */
  waitForShutdown(): Promise<void>;
}

export const createInkHost = (deps: InkHostDeps): InkHost => {
  const alternateScreen = deps.alternateScreen ?? true;
  const renderOnce = (): InkInstance => render(deps.appElement, { alternateScreen });

  let instance: InkInstance = renderOnce();
  let pausing: Promise<void> | undefined;

  const runInTerminal: RunInTerminal = async (fn) => {
    let release: (() => void) | undefined;
    pausing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = instance;
    current.unmount();
    await current.waitUntilExit();
    try {
      return await fn();
    } finally {
      instance = renderOnce();
      pausing = undefined;
      release?.();
    }
  };

  const waitForShutdown = async (): Promise<void> => {
    for (;;) {
      try {
        await instance.waitUntilExit();
      } catch {
        // waitUntilExit rejects when the app calls exit(err); treat as shutdown.
        return;
      }
      if (pausing === undefined) return;
      // A pause is in flight — wait for the new instance to be live, then re-await its exit.
      await pausing;
    }
  };

  return { runInTerminal, waitForShutdown };
};
