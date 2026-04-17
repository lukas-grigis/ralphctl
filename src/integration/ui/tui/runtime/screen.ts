/**
 * Terminal screen control for the Ink TUI.
 *
 * When the full app mounts (REPL or execute dashboard) we switch into the
 * alt-screen buffer (`CSI ? 1049 h`) so ralphctl takes over the terminal the
 * way vim, htop, or less does — no scrollback pollution, clean slate on
 * launch, terminal restored on exit. Cursor is hidden while the app is
 * running so the caret doesn't blink under rendered components.
 *
 * Restoration MUST always run, including on uncaught exceptions and signals,
 * otherwise the user is left with a hidden cursor or the alt buffer still
 * active. We register cleanup in two places:
 *   - `exitAltScreen()` — explicit, called on normal unmount.
 *   - `process.on('exit')` + `SIGINT` / `SIGTERM` / `uncaughtException`
 *      listeners — safety net.
 */

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// Wipe the whole screen + move cursor home. Needed because Ink's diff
// renderer only repaints cells with content — empty cells around a centered
// column keep whatever was in the alt-screen buffer before. Clearing on
// entry guarantees a blank canvas regardless of what the terminal restored.
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

let altScreenActive = false;
let safetyNetsInstalled = false;

function writeRaw(seq: string): void {
  if (process.stdout.isTTY) process.stdout.write(seq);
}

function restore(): void {
  if (!altScreenActive) return;
  altScreenActive = false;
  writeRaw(SHOW_CURSOR);
  writeRaw(LEAVE_ALT_SCREEN);
}

function installSafetyNets(): void {
  if (safetyNetsInstalled) return;
  safetyNetsInstalled = true;
  process.on('exit', restore);
  // Signals — we re-raise after restoring so exit code propagates naturally.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      restore();
      // Re-raise with default handling so parent shell sees the signal exit.
      process.kill(process.pid, sig);
    });
  }
  process.on('uncaughtException', (err) => {
    restore();
    // Re-throw asynchronously so Node's default handler prints + exits.
    setImmediate(() => {
      throw err;
    });
  });
}

/**
 * Enter the alt-screen buffer and hide the cursor. Idempotent.
 *
 * Call before `render(...)` so Ink paints into a clean buffer. The caller is
 * responsible for calling `exitAltScreen()` after `waitUntilExit()` resolves.
 */
export function enterAltScreen(): void {
  if (altScreenActive) return;
  if (!process.stdout.isTTY) return;
  installSafetyNets();
  altScreenActive = true;
  writeRaw(ENTER_ALT_SCREEN);
  writeRaw(CLEAR_SCREEN);
  writeRaw(HIDE_CURSOR);
}

/**
 * Restore the main screen buffer and cursor visibility. Idempotent.
 */
export function exitAltScreen(): void {
  restore();
}
