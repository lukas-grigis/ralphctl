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
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';

/**
 * DEC private mode 2004 — bracketed paste. With it on, the terminal wraps pasted content in
 * `ESC[200~` … `ESC[201~` so the prompts can tell a paste apart from typed keystrokes (without
 * it, pasted line breaks arrive as bare `\r` and Ink reports them as Enter → premature submit and
 * collapsed multi-line input). Enabled on mount, disabled on teardown so the mode never leaks into
 * the user's shell. Best-effort + TTY-guarded: a non-TTY (pipe / CI) writes nothing.
 */
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

const setBracketedPaste = (enabled: boolean): void => {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write(enabled ? BRACKETED_PASTE_ON : BRACKETED_PASTE_OFF);
  } catch {
    // Best-effort: a closed/erroring stdout must not crash the host. The prompts keep a
    // normalization fallback for terminals that never honoured the mode anyway.
  }
};

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
  const renderOnce = (): InkInstance => {
    // Enable bracketed paste alongside the mount; disabled on every unmount path below so it does
    // not bleed into a paused AI session or the user's shell after shutdown.
    setBracketedPaste(true);
    return render(deps.appElement, { alternateScreen });
  };

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
    // The user owns the terminal while `fn` runs — turn bracketed paste off so a paste into the
    // AI session isn't wrapped in markers. `renderOnce()` re-enables it when the TUI remounts.
    setBracketedPaste(false);
    try {
      return await fn();
    } finally {
      instance = renderOnce();
      pausing = undefined;
      release?.();
    }
  };

  const waitForShutdown = async (): Promise<void> => {
    try {
      return await runShutdownLoop();
    } finally {
      // Whatever exit path we leave on (clean quit, fatal error, AbortError re-throw), disable
      // bracketed paste so the mode never leaks into the user's shell after the TUI is gone.
      setBracketedPaste(false);
    }
  };

  const runShutdownLoop = async (): Promise<void> => {
    for (;;) {
      try {
        await instance.waitUntilExit();
      } catch (error) {
        // `waitUntilExit()` rejects only when Ink tears down on a fatal error — either a deliberate
        // `exit(err)` or an uncaught render error. A plain quit (`exit()` with no arg) RESOLVES, so
        // reaching this catch means something actually went wrong. The old blanket `catch {}` treated
        // every fatal as a clean shutdown, masking TUI crashes as exit 0.
        //
        // AbortError propagates untouched (project rule). Anything else: surface a one-line message
        // and a non-zero exit code before returning so wrapping scripts and CI see the failure.
        if (error instanceof AbortError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`ralphctl: the TUI exited with an error — ${msg}\n`);
        process.exitCode = 1;
        return;
      }
      if (pausing === undefined) return;
      // A pause is in flight — wait for the new instance to be live, then re-await its exit.
      await pausing;
    }
  };

  return { runInTerminal, waitForShutdown };
};
