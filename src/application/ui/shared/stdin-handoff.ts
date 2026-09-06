/**
 * Release `process.stdin` before an interactive child CLI (`grok` / `claude` / …) takes over the
 * terminal, and hand back a restore function that re-attaches the consumers it detached.
 *
 * Why this exists — the short version, full writeup in `.claude/docs/INTERACTIVE-HANDOFF-HANG.md`:
 * on startup an interactive CLI asks the terminal about its capabilities (DA1 `ESC[c`, XTVERSION,
 * kitty keyboard) and blocks until the terminal answers. The answer is written back into the tty's
 * input buffer, which parent and child share, so whoever reads first wins. A shell never competes
 * (it sits in `waitpid`); a Node parent still reading stdin does, and the child then waits forever
 * for a reply that landed in our buffer — a black screen. Driven through the real `createInkHost`
 * in a real iTerm window, Grok reached its pager in 0 of 8 launches before this helper and 8 of 8
 * with it.
 *
 * Unmounting Ink is NOT enough. Measured on Node 26 in a real iTerm window, reading
 * `process.stdin._handle.reading` across states:
 *
 *   - never touched                                      → reading = false
 *   - Ink-style armed (`readable` listener + raw mode)    → reading = true
 *   - after Ink-style teardown (listener off, raw off)    → reading = TRUE  ← still stealing bytes
 *   - after `pause()` + one tick                          → reading = false, DA1 reply not captured
 *
 * What actually stops the fd read is Node core: `process.stdin` carries a `'pause'` listener that
 * calls `readStop()` on the handle one tick later. So the whole job of this helper is to make
 * `pause()` EMIT `'pause'`, and `pause()` only emits when the stream is not already in the paused
 * state — which is why the order below is capture → remove → drain → settle → `pause()` → settle.
 *
 * Three traps, each measured:
 *
 *   1. **`read()` on an empty buffer restarts the handle.** A "drain until read() returns null"
 *      loop re-arms the tty (`reading` back to `true`) and reintroduces the exact bug it was
 *      meant to fix. Only ever read while `readableLength > 0`.
 *   2. **`removeAllListeners()` reaches into consumers you do not own.** That is how #327 broke
 *      `ScrollRegion`'s mouse-wheel handler — permanently, because the effect cleanup that would
 *      have re-attached it never ran. Remove exactly the handlers captured here, via
 *      `rawListeners()` so `once()` wrappers survive as `once` listeners, and put them back.
 *   3. **`pause()` is a documented no-op while a `'readable'` listener is attached**, and Node only
 *      forgets that listener's paused state on the next tick after it is removed. A synchronous
 *      remove-then-`pause()` therefore emits nothing and leaves the handle reading: in a pty that
 *      answers capability queries, that variant let the parent steal the reply in 8 of 18 runs,
 *      the settled variant in 0 of 18. Under the current unmount handoff Ink has already removed
 *      its listener ticks earlier, so the naive version happens to work there — the settle exists
 *      so the next handoff mechanism does not silently bring the hang back.
 *
 * Anything already buffered when the handoff starts is dropped on purpose: those bytes are stale
 * keystrokes and mouse reports aimed at a TUI that no longer exists, and leaving them in place
 * would feed them to the child as if the user had typed them.
 *
 * Do not extend this with raw-mode changes (Ink owns raw mode on both unmount and remount),
 * wall-clock settle delays before the spawn, or a fresh `/dev/tty` descriptor — all three were
 * measured and are non-fixes; the `/dev/tty` variant is deterministically worse (8/8 hangs). The
 * two `settle()` turns here are event-loop turns that let Node's own stream bookkeeping run, not
 * delays that hope the race resolves itself.
 */
import type { Readable } from 'node:stream';

/** Events whose listeners actively pull bytes out of the stream and must step aside. */
const HANDOFF_EVENTS = ['data', 'readable'] as const;

type StdinListener = (...args: unknown[]) => void;

interface CapturedListener {
  readonly event: (typeof HANDOFF_EVENTS)[number];
  readonly listener: StdinListener;
}

/**
 * One macrotask turn — enough for every `process.nextTick` the stream internals queued (the
 * `readable`-listener bookkeeping after `removeListener`, and `process.stdin`'s `readStop` after
 * `'pause'`) to have run.
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Detach every `data` / `readable` consumer, drop what is already buffered, and pause the stream so
 * Node stops reading the fd. Resolves only once that has taken effect — spawn the child after the
 * `await`, not before.
 *
 * Pair every release with its own restore before releasing again: a second release would capture an
 * empty listener set, so the first restore function is the only thing that can put the original
 * consumers back.
 *
 * @param stdin The stream to release; defaults to the process's real stdin.
 * @returns An idempotent restore function that re-attaches exactly the listeners that were removed
 *   (in their original order) and resumes the stream only if it had been flowing. Call it after the
 *   child exits and before anything remounts a TUI on top of the same stream. It restores whether
 *   the stream is flowing, not Node's flowing/paused/pristine tri-state — the first `pause()` makes
 *   `readableFlowing === null` unreachable for the rest of the stream's life, and with it the
 *   auto-resume that `on('data', …)` would otherwise trigger. No caller here depends on that
 *   distinction; one that did would have to re-arm the stream itself.
 */
export const releaseStdinForChild = async (stdin: Readable = process.stdin): Promise<() => void> => {
  const wasFlowing = stdin.readableFlowing === true;
  const captured: readonly CapturedListener[] = HANDOFF_EVENTS.flatMap((event) =>
    (stdin.rawListeners(event) as StdinListener[]).map((listener) => ({ event, listener }))
  );

  for (const { event, listener } of captured) stdin.removeListener(event, listener);

  // Trap 1: never read an empty buffer — that restarts the tty handle.
  while (stdin.readableLength > 0) {
    if (stdin.read() === null) break;
  }

  // Trap 3: let the `readable`-listener bookkeeping run so `pause()` below is a real transition
  // (and therefore emits `'pause'`) rather than the documented no-op.
  await settle();
  stdin.pause();
  // Node's `process.stdin` stops reading the fd from its `'pause'` listener on the NEXT tick. Do not
  // hand the terminal over until that has happened, or the spawn can still race it.
  await settle();

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const { event, listener } of captured) stdin.on(event, listener);
    // `on('data', …)` does not auto-resume a stream that was explicitly paused, so the resume has
    // to be deliberate — and only when the caller's stream was flowing to begin with.
    if (wasFlowing) stdin.resume();
  };
};
