/**
 * Ink-aware launcher host. Owns the live Ink instance and the "pause" semantics used when an interactive AI session
 * needs to take over the terminal.
 */
import type { ReactElement } from 'react';
import { type Instance as InkInstance, render } from 'ink';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { releaseStdinForChild } from '@src/application/ui/shared/stdin-handoff.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';

/** DEC private mode 2004 — bracketed paste. */
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
  /** Factory that builds the App element to mount. */
  readonly renderElement: () => ReactElement;
  /** Override whether Ink uses the terminal's alternate-screen buffer. */
  readonly alternateScreen?: boolean;
}

/** An Ink exit result carrying a line for the operator, printed once the alternate screen is gone. */
export interface ExitNote {
  readonly exitNote: string;
}

const isExitNote = (value: unknown): value is ExitNote =>
  typeof value === 'object' && value !== null && typeof (value as { exitNote?: unknown }).exitNote === 'string';

export interface InkHost {
  readonly runInTerminal: RunInTerminal;
  /** Resolves when the user truly quits the TUI (Ctrl-C / `q` / a fatal error). */
  waitForShutdown(): Promise<void>;
}

export const createInkHost = (deps: InkHostDeps): InkHost => {
  const alternateScreen = deps.alternateScreen ?? true;
  const renderOnce = (): InkInstance => {
    // Enable bracketed paste alongside the mount; disabled on every unmount path below so it does
    // not bleed into a paused AI session or the user's shell after shutdown.
    setBracketedPaste(true);
    // The app owns ctrl+c (quit chord); Ink's own exit would skip the live-run confirm.
    return render(deps.renderElement(), { alternateScreen, exitOnCtrlC: false });
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
    // Awaited, and restored before `renderOnce()`: a parent still reading stdin eats the child's terminal replies
    // (the black-screen hang — see .claude/docs/INTERACTIVE-HANDOFF-HANG.md).
    const restoreStdin = await releaseStdinForChild();
    // The user owns the terminal while `fn` runs — turn bracketed paste off so a paste into the
    // AI session isn't wrapped in markers. `renderOnce()` re-enables it when the TUI remounts.
    setBracketedPaste(false);
    try {
      return await fn();
    } finally {
      restoreStdin();
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
        const result: unknown = await instance.waitUntilExit();
        if (isExitNote(result)) process.stderr.write(`${result.exitNote}\n`);
      } catch (error) {
        // `waitUntilExit()` rejects only when Ink tears down on a fatal error — either a deliberate `exit(err)` or an
        // uncaught render error.
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
