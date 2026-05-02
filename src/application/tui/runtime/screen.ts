/**
 * Terminal screen control for the Ink TUI.
 *
 * When the full app mounts we switch into the alt-screen buffer
 * (`CSI ? 1049 h`) so ralphctl takes over the terminal the way vim,
 * htop, or less does — no scrollback pollution, clean slate on launch,
 * terminal restored on exit. Cursor is hidden while the app is running.
 *
 * Restoration MUST always run, including on uncaught exceptions and signals,
 * otherwise the user is left with a hidden cursor or the alt buffer still
 * active. Restoration runs from two places:
 *   - `exitAltScreen()` — explicit, called on normal unmount.
 *   - The shutdown coordinator (see `runtime/shutdown.ts`) — invokes the
 *     restore handler on SIGINT / SIGTERM / SIGHUP / uncaughtException
 *     before the process exits. `process.on('exit', restore)` is a
 *     final belt-and-braces backstop for paths that bypass the
 *     coordinator (e.g. process.exit() called directly).
 */

import { registerShutdown } from '@src/application/runtime/shutdown.ts';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

let altScreenActive = false;
let safetyNetsInstalled = false;

function writeRaw(seq: string): void {
  if (process.stdout.isTTY) process.stdout.write(seq);
}

function restore(): void {
  if (!altScreenActive) return;
  altScreenActive = false;
  writeRaw(DISABLE_BRACKETED_PASTE);
  writeRaw(SHOW_CURSOR);
  writeRaw(LEAVE_ALT_SCREEN);
}

function installSafetyNets(): void {
  if (safetyNetsInstalled) return;
  safetyNetsInstalled = true;
  // Final belt-and-braces — `process.exit()` skips signal handlers but
  // runs `exit` listeners, so this catches direct-exit paths.
  process.on('exit', restore);
  // The shutdown coordinator (runtime/shutdown.ts) calls every
  // registered handler on SIGINT / SIGTERM / SIGHUP / uncaughtException
  // BEFORE exiting, so the alt-screen restore runs while stdout is
  // still flushable and the terminal can still receive escape sequences.
  registerShutdown('alt-screen-restore', restore);
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
  writeRaw(ENABLE_BRACKETED_PASTE);
}

/**
 * Restore the main screen buffer and cursor visibility. Idempotent.
 */
export function exitAltScreen(): void {
  restore();
}
