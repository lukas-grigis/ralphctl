/**
 * Terminal handoff for interactive AI sessions.
 *
 * When the Ink TUI is mounted (alt-screen buffer, frame redraws, hidden
 * cursor) and an interactive AI session needs to take over the terminal —
 * `claude` or `copilot` running with `stdio: 'inherit'` — the two compete
 * for the same stdout. The result is visual chaos: Claude's prompt writes
 * over Ink's last frame, Ink's next redraw writes over Claude, cursor
 * moves fight each other.
 *
 * The fix is the vim `:!cmd` pattern: suspend the TUI, let the child own
 * the terminal cleanly, then resume.
 *
 * Flow inside `withSuspendedTui(cb)` when the TUI is mounted:
 *   1. `exitAltScreen()` — restore the main screen buffer, show cursor.
 *   2. `await cb()` — the AI CLI runs with `stdio: 'inherit'` and owns
 *      the terminal. `spawnSync` blocks the Node event loop so Ink's
 *      `useInput` can't fire on stale input.
 *   3. `enterAltScreen()` — back into the app's buffer, cursor hidden.
 *   4. `instance.clear()` — force Ink to repaint from scratch.
 *
 * When no TUI is mounted (plain-text CLI, tests) this is a pure pass-through.
 */

import { enterAltScreen, exitAltScreen } from './screen.ts';

interface SuspendableInstance {
  clear(): void;
}

let activeInstance: SuspendableInstance | null = null;

/**
 * Register the mounted Ink render instance so suspension knows how to
 * repaint on resume. Called once from `mountInkApp(...)` after `render()`.
 * Returns a teardown function the caller must invoke in its `finally` so
 * the singleton doesn't leak after unmount.
 */
export function registerTuiInstance(instance: SuspendableInstance): () => void {
  activeInstance = instance;
  return () => {
    if (activeInstance === instance) {
      activeInstance = null;
    }
  };
}

/** Exposed for tests — treats the TUI as not-mounted even if an instance was registered. */
export function isTuiMounted(): boolean {
  return activeInstance !== null;
}

/**
 * Run `cb` with the TUI suspended. No-op wrapper when nothing is mounted.
 *
 * Throws propagate — the `finally` always restores the alt-screen so a
 * failing AI session doesn't leave the terminal in a broken state.
 */
export async function withSuspendedTui<T>(cb: () => Promise<T> | T): Promise<T> {
  const instance = activeInstance;
  if (instance === null) {
    return cb();
  }

  exitAltScreen();
  try {
    return await cb();
  } finally {
    enterAltScreen();
    // `clear()` discards Ink's internal buffer so the next reconcile paints
    // from scratch — otherwise Ink would diff against its pre-suspend state
    // and no-op, leaving whatever the AI left on screen visible through
    // Ink's gaps.
    instance.clear();
  }
}
