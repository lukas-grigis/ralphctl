/**
 * `runInteractive(fn)` — hand the terminal to a child process while the
 * Ink TUI is mounted.
 *
 * Problem: Ink owns the alt-screen and writes its frames to `stdout` on
 * every reconcile. If a child process is spawned with `stdio: 'inherit'`,
 * both Ink and the child write to the same TTY and their output
 * interleaves messily.
 *
 * Solution: a global "interactive" flag the App reads. While the flag is
 * set, the App renders `null` so Ink's reconciler emits no visible
 * output. We then `exitAltScreen()` so the user sees the main terminal,
 * spawn the child, await its exit, `enterAltScreen()` again, and clear
 * the flag — the App re-renders into the freshly entered alt-screen.
 *
 * Non-TTY environments (CI, piped) just run `fn` directly — there is no
 * Ink to suppress.
 *
 * Idempotent / nest-safe: re-entrant calls inside an already-interactive
 * region run `fn` directly without further screen ops.
 */

import { enterAltScreen, exitAltScreen } from '@src/application/tui/runtime/screen.ts';

type Listener = (active: boolean) => void;

const listeners = new Set<Listener>();
let active = false;

/** Current state — `true` while a child owns the terminal. */
export function isInteractiveActive(): boolean {
  return active;
}

/**
 * Subscribe to interactive-state transitions. Called with the new value
 * each time it flips. Returns an unsubscribe function.
 */
export function subscribeInteractive(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setActive(next: boolean): void {
  if (active === next) return;
  active = next;
  // Snapshot — a listener unsubscribing during dispatch must not skip peers.
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch {
      // Mirror the rest of the codebase: a thrown subscriber must not
      // stall delivery to the rest of the set. Errors are swallowed
      // silently because we have no LoggerPort at this layer (this
      // helper runs deep inside chain leaves where pulling a logger
      // would invert dependencies).
    }
  }
}

/**
 * Yield to the runtime so React has a chance to flush the App's
 * `null`-render before we hand the terminal to the child. Without this
 * the child's first output can collide with Ink's last frame.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 16); // one animation frame is enough.
  });
}

/**
 * Run `fn` while the TUI yields the terminal. Returns whatever `fn`
 * returns (or rejects with whatever `fn` rejects). Always restores the
 * alt-screen on exit, even when `fn` throws.
 */
export async function runInteractive<T>(fn: () => Promise<T>): Promise<T> {
  // No alt-screen to coordinate around: just run.
  if (!process.stdout.isTTY) return fn();
  // Already inside an interactive region — nest without further screen ops.
  if (active) return fn();

  setActive(true);
  await flush();
  exitAltScreen();
  try {
    return await fn();
  } finally {
    enterAltScreen();
    setActive(false);
  }
}
