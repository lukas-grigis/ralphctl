/**
 * Release `process.stdin` before an interactive child CLI (`grok` / `claude` / …) takes over the terminal, and hand
 * back a restore function that re-attaches the consumers it detached.
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
 * One macrotask turn — enough for every `process.nextTick` the stream internals queued (the `readable`-listener
 * bookkeeping after `removeListener`.
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Detach every `data` / `readable` consumer, drop what is already buffered, and pause the stream so Node stops
 * reading the fd.
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
