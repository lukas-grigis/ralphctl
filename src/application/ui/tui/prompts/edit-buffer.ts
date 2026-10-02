/** Shared editing core for the text prompts: ref-backed buffer + cursor, caret blink, and the common delete chords. */

import { useEffect, useRef, useState, type RefObject } from 'react';

export type UpdateCursor = (next: (prev: number) => number) => void;
export type UpdateBufAndCursor = (transform: (b: string, c: number) => [string, number]) => void;
export type InsertAtCursor = (text: string) => void;

export interface EditBuffer {
  readonly buf: string;
  readonly cursor: number;
  readonly bufRef: RefObject<string>;
  readonly cursorRef: RefObject<number>;
  readonly updateCursor: UpdateCursor;
  readonly updateBufAndCursor: UpdateBufAndCursor;
  readonly insertAtCursor: InsertAtCursor;
}

/**
 * Buffer + cursor state for an editable field, backed by refs so handlers always read the latest values even when
 * multiple keystrokes arrive between renders (paste + Enter, ctrl+u + Enter, fast typing).
 */
export const useEditBuffer = (initial: string): EditBuffer => {
  const [buf, setBuf] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);

  const bufRef = useRef<string>(initial);
  const cursorRef = useRef<number>(initial.length);

  // Refs are advanced synchronously, not inside a state updater: React may defer an updater to render time when other
  // work is pending, and an Enter typed right behind the text would then submit a stale buffer.
  const updateCursor: UpdateCursor = (next) => {
    const value = next(cursorRef.current);
    cursorRef.current = value;
    setCursor(value);
  };

  // Atomically update both buf and cursor to avoid stale-closure races on rapid keystrokes.
  const updateBufAndCursor: UpdateBufAndCursor = (transform) => {
    const [newBuf, newCursor] = transform(bufRef.current, cursorRef.current);
    bufRef.current = newBuf;
    cursorRef.current = newCursor;
    setBuf(newBuf);
    setCursor(newCursor);
  };

  // Insert text at the cursor. Routed through updateBufAndCursor so refs stay authoritative.
  const insertAtCursor: InsertAtCursor = (text) => {
    if (text.length === 0) return;
    updateBufAndCursor((b, c) => [b.slice(0, c) + text + b.slice(c), c + text.length]);
  };

  return { buf, cursor, bufRef, cursorRef, updateCursor, updateBufAndCursor, insertAtCursor };
};

/** Half-second caret blink; the cleanup keeps the timer from leaking across remounts of per-step keyed prompts. */
export const useCaretBlink = (): boolean => {
  const [caretOn, setCaretOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), 500);
    return () => {
      clearInterval(id);
    };
  }, []);
  return caretOn;
};

/** Backspace / delete: drop the character before the cursor. */
export const deleteBack = (b: string, c: number): [string, number] => {
  if (c === 0) return [b, c];
  return [b.slice(0, c - 1) + b.slice(c), c - 1];
};

/** ctrl+u: clear the whole buffer. */
export const clearAll = (): [string, number] => ['', 0];

/** ctrl+w: drop trailing whitespace before the cursor (newlines included), then the preceding word. */
export const deleteWordBack = (b: string, c: number): [string, number] => {
  const before = b.slice(0, c);
  const after = b.slice(c);
  const trimmed = before.replace(/\s+$/u, '');
  const lastBoundary = trimmed.search(/\S+$/u);
  const newBefore = lastBoundary === -1 ? '' : trimmed.slice(0, lastBoundary);
  return [newBefore + after, newBefore.length];
};
