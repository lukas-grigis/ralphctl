/** Free-text input prompt (optional inline `validate` / `preview`). */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, type Key } from 'ink';
import { usePromptInput } from '@src/application/ui/tui/prompts/use-prompt-input.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { stripPasteMarkers, usePaste } from '@src/application/ui/tui/prompts/use-paste.ts';
import { usePromptHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

/**
 * Flatten a pasted payload for a single-line field: collapse every run of whitespace (including the newlines a
 * multi-line paste carries) to one space, then trim the edges.
 */
const flattenToSingleLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

type UpdateCursor = (next: (prev: number) => number) => void;
type UpdateBufAndCursor = (transform: (b: string, c: number) => [string, number]) => void;
type InsertAtCursor = (text: string) => void;

interface LineBuffer {
  readonly buf: string;
  readonly cursor: number;
  readonly bufRef: React.RefObject<string>;
  readonly updateCursor: UpdateCursor;
  readonly updateBufAndCursor: UpdateBufAndCursor;
  readonly insertAtCursor: InsertAtCursor;
}

/**
 * Buffer + cursor state for a single-line editable field, backed by refs so handlers always read the latest values
 * even when multiple keystrokes arrive between renders (paste + Enter, ctrl+u + Enter, fast typing).
 */
const useLineBuffer = (initial: string): LineBuffer => {
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

  return { buf, cursor, bufRef, updateCursor, updateBufAndCursor, insertAtCursor };
};

/** ←/→ and Home/End (+ ctrl+a/ctrl+e) cursor movement. Returns true when the key was handled. */
const handleNavigationKey = (
  key: Key,
  input: string,
  bufRef: React.RefObject<string>,
  updateCursor: UpdateCursor
): boolean => {
  if (key.leftArrow) {
    updateCursor((c) => Math.max(0, c - 1));
    return true;
  }
  if (key.rightArrow) {
    updateCursor((c) => Math.min(bufRef.current.length, c + 1));
    return true;
  }
  // Home / ctrl+a — jump to start of buffer.
  if (key.home || (key.ctrl && input === 'a')) {
    updateCursor(() => 0);
    return true;
  }
  // End / ctrl+e — jump to end of buffer.
  if (key.end || (key.ctrl && input === 'e')) {
    updateCursor(() => bufRef.current.length);
    return true;
  }
  return false;
};

/** Backspace/delete, ctrl+u (clear), ctrl+w (delete word). Returns true when the key was handled. */
const handleEditingKey = (key: Key, input: string, updateBufAndCursor: UpdateBufAndCursor): boolean => {
  if (key.backspace || key.delete) {
    updateBufAndCursor((b, c) => {
      if (c === 0) return [b, c];
      return [b.slice(0, c - 1) + b.slice(c), c - 1];
    });
    return true;
  }
  if (key.ctrl && input === 'u') {
    updateBufAndCursor(() => ['', 0]);
    return true;
  }
  if (key.ctrl && input === 'w') {
    // Delete from cursor back to the start of the previous word.
    updateBufAndCursor((b, c) => {
      const before = b.slice(0, c);
      const after = b.slice(c);
      const trimmed = before.replace(/\s+$/u, '');
      const lastBoundary = trimmed.search(/\S+$/u);
      const newBefore = lastBoundary === -1 ? '' : trimmed.slice(0, lastBoundary);
      return [newBefore + after, newBefore.length];
    });
    return true;
  }
  return false;
};

/** Printable-character insertion, including the shift+letter and pasted-chunk fallbacks. */
const handleInsertionKey = (key: Key, input: string, insertAtCursor: InsertAtCursor): void => {
  // Printable characters (including pasted multi-char input): insert at cursor. Fallback for terminals that don't
  // honour mode 2004 — a single-chunk paste arrives here.
  if (input.length > 0 && !key.meta && !key.ctrl && !key.tab) {
    const stripped = stripPasteMarkers(input);
    insertAtCursor(/[\r\n]/u.test(stripped) ? flattenToSingleLine(stripped) : stripped);
    return;
  }
  if (input.length > 0 && key.shift) {
    // shift+letter still produces a printable
    insertAtCursor(stripPasteMarkers(input));
  }
};

export interface TextPromptProps {
  readonly message: string;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
  readonly initial?: string;
  /**
   * Label shown after `esc` in the hint row. Defaults to "cancel"; wizards that interpret Esc as "step back" should
   * pass "back" so the hint matches the actual behaviour.
   */
  readonly escLabel?: string;
  /** Returns an error message to block submit. Shown inline once the buffer is non-empty or ↵ was tried. */
  readonly validate?: (value: string) => string | undefined;
  /** Dim one-line preview under the field, derived from the buffer. */
  readonly preview?: (value: string) => string | undefined;
}

const TEXT_HINTS = [{ keys: '↵', label: 'submit' }];

export const TextPrompt = ({
  message,
  onSubmit,
  onCancel,
  initial = '',
  escLabel = 'cancel',
  validate,
  preview,
}: TextPromptProps): React.JSX.Element => {
  const { buf, cursor, bufRef, updateCursor, updateBufAndCursor, insertAtCursor } = useLineBuffer(initial);
  const [caretOn, setCaretOn] = useState(true);
  const [attempted, setAttempted] = useState(false);

  // Bracketed-paste channel. A single-line field flattens the payload: runs of whitespace and the
  // newlines of a multi-line paste collapse to one space so the field stays single-line.
  const paste = usePaste((payload) => insertAtCursor(flattenToSingleLine(payload)));

  // Half-second blink. The cleanup keeps the timer from leaking across remounts of the
  // wizards that key TextPrompts per step.
  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), 500);
    return () => {
      clearInterval(id);
    };
  }, []);

  usePromptHints(TEXT_HINTS, escLabel);

  usePromptInput((input, key) => {
    // Bracketed paste first — consumed before any key dispatch so marker bytes and embedded
    // newlines never submit or land verbatim in the buffer.
    if (paste.consume(input)) return;
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (validate?.(bufRef.current) !== undefined) {
        setAttempted(true);
        return;
      }
      onSubmit(bufRef.current);
      return;
    }
    if (handleNavigationKey(key, input, bufRef, updateCursor)) return;
    if (handleEditingKey(key, input, updateBufAndCursor)) return;
    handleInsertionKey(key, input, insertAtCursor);
  });

  // Render the single input line with the caret at the cursor position. When caretOn: block glyph replaces the char
  // under the cursor (or trails the last char).
  const beforeCursor = buf.slice(0, cursor);
  const charAtCursor = buf.slice(cursor, cursor + 1); // '' when cursor is past end
  const afterCursor = buf.slice(cursor + 1);

  const error = attempted || buf.length > 0 ? validate?.(buf) : undefined;
  const previewText = error === undefined ? preview?.(buf) : undefined;

  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text color={inkColors.primary} bold>
        {glyphs.actionCursor} {message}
      </Text>
      <Box>
        <Text dimColor>{glyphs.arrowRight} </Text>
        <Text>{beforeCursor}</Text>
        {caretOn ? (
          <>
            <Text color={inkColors.highlight}>{glyphs.caretBlock}</Text>
            <Text>{afterCursor}</Text>
          </>
        ) : (
          <>
            <Text>{charAtCursor.length > 0 ? charAtCursor : ' '}</Text>
            <Text>{afterCursor}</Text>
          </>
        )}
      </Box>
      {error !== undefined && (
        <Text color={inkColors.error}>
          {glyphs.cross} {error}
        </Text>
      )}
      {previewText !== undefined && <Text dimColor>{previewText}</Text>}
      <Text dimColor wrap="truncate-end">
        ↵ submit · esc {escLabel} · ←/→ cursor · home/end edge · ctrl+w word · ctrl+u clear
      </Text>
    </Box>
  );
};
