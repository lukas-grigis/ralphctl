/**
 * Bracketed-paste filter installed on `process.stdin` while the Ink TUI is
 * mounted.
 *
 * Once `screen.ts` enables bracketed-paste mode (`CSI ? 2004 h`), terminals
 * wrap any pasted block in `\x1b[200~ ... \x1b[201~`. We strip those markers
 * before Ink's input layer reads the buffer so:
 *
 *   - The literal escape sequences don't show up as garbage characters.
 *   - The user's view hotkeys (e.g. `D` to background, `c` to cancel)
 *     don't fire when a hotkey letter happens to appear inside a pasted
 *     block. With the markers stripped we still see chunked input, but
 *     the chunks land as a single `useInput` invocation per data event,
 *     which is what the editor-prompt's multi-char insert path expects.
 *
 * The filter is a Transform-style read-side hook: we monkey-patch
 * `stdin.read()` and `stdin.on('data', …)` chunks by wrapping the stream
 * in a pass-through with the markers removed. This is intentionally narrow
 * — we do not try to coalesce a multi-chunk paste into a single emit.
 *
 * Restoration is idempotent: the install function returns a teardown
 * callback that swaps the original methods back so unmounting the TUI (or
 * an exception in render) leaves stdin in its original state.
 */

import type { Readable } from 'node:stream';

const ESC = '';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const MARKER_RE = new RegExp(`${ESC}\\[20[01]~`, 'g');

/**
 * Strip bracketed-paste markers from `chunk`. Exported for unit testing —
 * the stream-level wiring is integration-tested elsewhere.
 */
export function stripPasteMarkers(chunk: Buffer | string): Buffer | string {
  if (typeof chunk === 'string') {
    if (!chunk.includes(ESC)) return chunk;
    return chunk.replace(MARKER_RE, '');
  }
  // Cheap bytewise check: only allocate a string view when an ESC byte (0x1b)
  // is present. Most keystrokes are a single non-escape byte and bypass the
  // regex entirely.
  if (chunk.indexOf(0x1b) === -1) return chunk;
  const text = chunk.toString('utf8');
  if (!text.includes(ESC)) return chunk;
  return Buffer.from(text.replace(MARKER_RE, ''), 'utf8');
}

interface PatchedStream {
  emit: (event: string, ...args: unknown[]) => boolean;
}

/**
 * Wrap stdin's `data` emitter so every chunk passes through `stripPasteMarkers`
 * before downstream listeners (Ink's input bridge) see it. Returns an unwind
 * callback that restores the original `emit`.
 *
 * We patch `emit('data', …)` rather than installing a `.on('data')` listener
 * so we run *before* Ink's listener — listeners attached after ours would see
 * the unfiltered chunk, but the listeners Ink installs are added after this
 * function runs (we register at mount time, before `render`).
 */
export function installPasteFilter(stream: Readable = process.stdin): () => void {
  const target = stream as Readable & PatchedStream;
  const originalEmit = target.emit.bind(target);
  target.emit = function patchedEmit(event: string, ...args: unknown[]): boolean {
    if (event !== 'data' || args.length === 0) return originalEmit(event, ...args);
    const chunk = args[0];
    if (!(chunk instanceof Buffer) && typeof chunk !== 'string') {
      return originalEmit(event, ...args);
    }
    const filtered = stripPasteMarkers(chunk);
    return originalEmit(event, filtered, ...args.slice(1));
  };

  return () => {
    target.emit = originalEmit;
  };
}

export const PASTE_MARKERS = { start: PASTE_START, end: PASTE_END } as const;
