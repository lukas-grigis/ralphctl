/** Bracketed-paste detector for the text-input prompts. */

import { useEffect, useRef } from 'react';

const ESC = String.fromCharCode(27);
/** `ESC[200~` and the bare `[200~` Ink leaves after stripping a leading ESC. */
const START_MARKERS = [`${ESC}[200~`, '[200~'] as const;
/** `ESC[201~` and the bare `[201~`. */
const END_MARKERS = [`${ESC}[201~`, '[201~'] as const;

/** Normalize pasted line endings to `\n` so the textarea's `\n`-split cursor math holds. */
export const normalizePasteNewlines = (text: string): string => text.replace(/\r\n?/gu, '\n');

/** Strip any stray bracketed-paste markers from a fragment. */
export const stripPasteMarkers = (text: string): string =>
  text.replaceAll(`${ESC}[200~`, '').replaceAll(`${ESC}[201~`, '').replaceAll('[200~', '').replaceAll('[201~', '');

/** Find the first occurrence of any marker in `text`; returns its index + matched length. */
const firstMarker = (text: string, markers: readonly string[]): { index: number; length: number } | undefined => {
  let best: { index: number; length: number } | undefined;
  for (const marker of markers) {
    const at = text.indexOf(marker);
    if (at !== -1 && (best === undefined || at < best.index)) best = { index: at, length: marker.length };
  }
  return best;
};

export interface PasteController {
  /** Feed one raw `useInput` chunk through the paste detector. */
  consume(input: string): boolean;
}

/** Build a paste controller bound to `onPaste`. */
/** Max time (ms) to wait for the closing `[201~` marker after the opening one arrives. */
const PASTE_WATCHDOG_MS = 150;

export const usePaste = (onPaste: (payload: string) => void): PasteController => {
  // `undefined` = not currently inside a paste. A string (possibly empty) = accumulating body.
  const pending = useRef<string | undefined>(undefined);
  // Hold the timer ID so it can be cancelled when the end marker arrives normally.
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Stable ref so the timer callback always calls the latest onPaste (avoids stale-closure bugs
  // when the parent re-renders with a new insertAtCursor closure between chunks).
  const onPasteRef = useRef(onPaste);
  onPasteRef.current = onPaste;

  const cancelWatchdog = (): void => {
    if (watchdog.current !== undefined) {
      clearTimeout(watchdog.current);
      watchdog.current = undefined;
    }
  };

  // Arm (or reset) the watchdog. Called each time we enter or extend a pending paste.
  const armWatchdog = (): void => {
    cancelWatchdog();
    watchdog.current = setTimeout(() => {
      watchdog.current = undefined;
      if (pending.current !== undefined) {
        const payload = pending.current;
        pending.current = undefined;
        onPasteRef.current(normalizePasteNewlines(stripPasteMarkers(payload)));
      }
    }, PASTE_WATCHDOG_MS);
  };

  const flush = (raw: string): void => {
    cancelWatchdog();
    onPasteRef.current(normalizePasteNewlines(stripPasteMarkers(raw)));
  };

  // Clear any pending timer on unmount so it cannot fire into an unmounted component.
  useEffect(() => () => cancelWatchdog(), []);

  const consume = (input: string): boolean => {
    if (pending.current !== undefined) {
      // Mid-paste: append until the closing marker shows up (handles chunk-split pastes).
      const end = firstMarker(input, END_MARKERS);
      if (end === undefined) {
        pending.current += input;
        armWatchdog(); // reset the deadline on each arriving chunk
        return true;
      }
      const payload = pending.current + input.slice(0, end.index);
      pending.current = undefined;
      flush(payload);
      return true;
    }

    const start = firstMarker(input, START_MARKERS);
    if (start === undefined) return false;

    // A start marker is present. The body begins right after it; the closing marker may be in the
    // same chunk (small paste) or a later one (chunk-split paste).
    const afterStart = input.slice(start.index + start.length);
    const end = firstMarker(afterStart, END_MARKERS);
    if (end === undefined) {
      pending.current = afterStart;
      armWatchdog(); // arm watchdog: close marker must arrive within PASTE_WATCHDOG_MS
      return true;
    }
    flush(afterStart.slice(0, end.index));
    return true;
  };

  return { consume };
};
