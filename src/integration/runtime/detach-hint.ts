/**
 * Tiny module-level latch that lets the Ink TUI defer a one-line message
 * until after the alt-screen buffer has been restored.
 *
 * The detach hotkey in `<ExecuteView />` forks a daemon then unmounts the
 * Ink app. Printing the "Detached. Re-attach with …" hint from inside the
 * view would scroll over the alt-screen frame; printing from inside Ink's
 * exit lifecycle would be discarded because the alt-screen is still active.
 *
 * Solution: stash the hint here, then have `mountInkApp`'s finally block
 * (after `exitAltScreen()`) drain and print it on the normal terminal.
 */

let pendingHint: string | null = null;

export function setDetachHint(message: string): void {
  pendingHint = message;
}

export function consumeDetachHint(): string | null {
  const message = pendingHint;
  pendingHint = null;
  return message;
}
