/**
 * Best-effort terminal-mode reset before a nested interactive CLI (`grok` / `claude` / …) takes
 * over the terminal. Shared by both handoff paths so the suspend path and the pre-mount unmount
 * fallback leave the terminal in the same state.
 *
 * Ink's `suspendTerminal` already exits the alt-screen, drops raw mode, and restores bracketed
 * paste through its own refcount. What it does not reset are modes Ink never set and therefore
 * does not know about:
 *
 *   1. Mouse reporting. `ScrollRegion` enables SGR mouse tracking for wheel scrolling; left on,
 *      the child's terminal floods its stdin with CSI sequences instead of keystrokes.
 *   2. Kitty keyboard protocol and cursor visibility, when something other than Ink enabled them.
 *   3. A synchronized-update region opened by a previous occupant of the terminal. ESU is
 *      idempotent when no region is open, so sending it unconditionally is free insurance.
 *      (Ink itself cannot leave one open — it writes BSU and ESU synchronously inside a single
 *      function body, and `beginSuspend` flushes its throttled writers before pausing.)
 *
 * `process.stdin` is deliberately NOT touched here. Ink's `pauseInput` / `resumeInput` pair owns
 * raw mode and its own listener across a suspension, and reaching into the shared stream from
 * outside that pair breaks consumers Ink does not know about — `removeAllListeners('data')`
 * detached `ScrollRegion`'s wheel handler permanently, because under `suspendTerminal` the React
 * tree stays mounted and its effect cleanup never re-runs.
 *
 * Known gap: nothing re-enables mouse reporting when the child exits, so wheel scrolling stays off
 * for the rest of the session. Re-arming it belongs in `ScrollRegion` on a resume signal.
 *
 * Writes go through `writeSync` on the stdout fd when available so the sequences reach the
 * terminal before the child is spawned — an async `stdout.write` can still be queued when the
 * child's first capability query goes out.
 */

import { writeSync } from 'node:fs';

const RELEASE_STDOUT =
  // End sync region (idempotent if none open), mouse reporting off, kitty off, leave alt-screen,
  // show cursor, bracketed paste off.
  // Soft-reset (CSI !p) deliberately omitted — it can leave iTerm in a state where a nested
  // Grok never reaches pager started.
  '\x1b[?2026l' +
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l\x1b[?1004l' +
  '\x1b[<u\x1b[?1049l\x1b[?25h\x1b[?2004l';

const writeRelease = (): void => {
  const fd = process.stdout.fd;
  if (typeof fd === 'number' && fd >= 0) {
    writeSync(fd, RELEASE_STDOUT);
    return;
  }
  process.stdout.write(RELEASE_STDOUT);
};

export const releaseTerminalForChild = (): void => {
  if (process.stdin.isTTY) {
    try {
      // Cooked mode so Ctrl-C reaches the child's process group. Idempotent under Ink's suspend,
      // which has already done this; load-bearing on the unmount path, where no Ink instance is
      // left to do it.
      process.stdin.setRawMode(false);
    } catch {
      // Non-TTY fakes / already-cooked stdin must not fail the handoff.
    }
  }
  if (!process.stdout.isTTY) return;
  try {
    writeRelease();
  } catch {
    // Closed stdout / fd-less test fakes must not crash the host.
  }
};
