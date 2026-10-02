/** Free-text input prompt (optional inline `validate` / `preview`). */

import React, { useMemo, useState } from 'react';
import { Box, Text, type Key } from 'ink';
import { usePromptInput } from '@src/application/ui/tui/prompts/use-prompt-input.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { stripPasteMarkers, usePaste } from '@src/application/ui/tui/prompts/use-paste.ts';
import { usePromptHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import {
  clearAll,
  deleteBack,
  deleteWordBack,
  useCaretBlink,
  useEditBuffer,
  type InsertAtCursor,
  type UpdateBufAndCursor,
  type UpdateCursor,
} from '@src/application/ui/tui/prompts/edit-buffer.ts';

/**
 * Flatten a pasted payload for a single-line field: collapse every run of whitespace (including the newlines a
 * multi-line paste carries) to one space, then trim the edges.
 */
const flattenToSingleLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

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
    updateBufAndCursor(deleteBack);
    return true;
  }
  if (key.ctrl && input === 'u') {
    updateBufAndCursor(clearAll);
    return true;
  }
  if (key.ctrl && input === 'w') {
    updateBufAndCursor(deleteWordBack);
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
  const { buf, cursor, bufRef, updateCursor, updateBufAndCursor, insertAtCursor } = useEditBuffer(initial);
  const caretOn = useCaretBlink();
  const [attempted, setAttempted] = useState(false);

  // Bracketed-paste channel. A single-line field flattens the payload: runs of whitespace and the
  // newlines of a multi-line paste collapse to one space so the field stays single-line.
  const paste = usePaste((payload) => insertAtCursor(flattenToSingleLine(payload)));

  // Memoised so the caret blink doesn't re-run validate (path-picker's stats the disk).
  const validation = useMemo(() => validate?.(buf), [buf, validate]);

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

  const error = attempted || buf.length > 0 ? validation : undefined;
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
