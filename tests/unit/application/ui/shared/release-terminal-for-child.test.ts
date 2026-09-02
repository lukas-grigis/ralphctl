/**
 * Pins the terminal-mode reset that runs before every interactive AI handoff — the modes Ink
 * never set and therefore cannot restore on its own. Leaving mouse reporting on floods the
 * child's stdin with CSI sequences instead of keystrokes; refine-with-Grok hung after
 * `leader.startup_kill` with a blank screen and no Ctrl-C. See `release-terminal-for-child.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseTerminalForChild } from '@src/application/ui/shared/release-terminal-for-child.ts';

describe('releaseTerminalForChild', () => {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;

  const stubStdin = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const stdin = { isTTY: true, setRawMode: vi.fn(), ...overrides };
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    return stdin;
  };

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: originalStdout, configurable: true });
    vi.restoreAllMocks();
  });

  it('writes ESU + mouse-off + kitty-off + leave-alt-screen + show-cursor + bracketed-paste-off on a TTY stdout', () => {
    const write = vi.fn();
    // No `fd` → falls back to async write (writeSync needs a real descriptor).
    Object.defineProperty(process, 'stdout', {
      value: { isTTY: true, write },
      configurable: true,
    });
    stubStdin();

    releaseTerminalForChild();

    expect(write).toHaveBeenCalledTimes(1);
    const payload = write.mock.calls[0]![0] as string;
    expect(payload).toContain('\x1b[?2026l'); // end synchronized update
    expect(payload).not.toContain('\x1b[!p'); // soft-reset omitted (breaks nested Grok on iTerm)
    expect(payload).toContain('\x1b[?1000l'); // mouse reporting off
    expect(payload).toContain('\x1b[?1006l'); // SGR mouse reporting off
    expect(payload).toContain('\x1b[<u'); // kitty keyboard off
    expect(payload).toContain('\x1b[?1049l'); // leave alt-screen
    expect(payload).toContain('\x1b[?25h'); // show cursor
    expect(payload).toContain('\x1b[?2004l'); // bracketed paste off
  });

  it('cooks stdin so Ctrl-C reaches the child, and leaves the stream itself to Ink', () => {
    // Ink's pauseInput/resumeInput pair owns the stdin listener across a suspension. Detaching
    // listeners here took `ScrollRegion`'s wheel handler with it — the React tree stays mounted
    // under suspendTerminal, so its effect cleanup never re-attaches.
    const stdin = stubStdin({
      pause: vi.fn(),
      read: vi.fn(() => null),
      removeAllListeners: vi.fn(),
    });
    Object.defineProperty(process, 'stdout', {
      value: { isTTY: false, write: vi.fn() },
      configurable: true,
    });

    releaseTerminalForChild();

    expect(stdin['setRawMode']).toHaveBeenCalledWith(false);
    expect(stdin['removeAllListeners']).not.toHaveBeenCalled();
    expect(stdin['pause']).not.toHaveBeenCalled();
    expect(stdin['read']).not.toHaveBeenCalled();
  });

  it('is a no-op write on non-TTY stdout and still cooks a TTY stdin', () => {
    const write = vi.fn();
    Object.defineProperty(process, 'stdout', {
      value: { isTTY: false, write },
      configurable: true,
    });
    const stdin = stubStdin();

    releaseTerminalForChild();

    expect(write).not.toHaveBeenCalled();
    expect(stdin['setRawMode']).toHaveBeenCalledWith(false);
  });

  it('survives a stdin that cannot leave raw mode', () => {
    stubStdin({
      setRawMode: vi.fn(() => {
        throw new Error('not a tty');
      }),
    });
    const write = vi.fn();
    Object.defineProperty(process, 'stdout', { value: { isTTY: true, write }, configurable: true });

    expect(() => {
      releaseTerminalForChild();
    }).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
