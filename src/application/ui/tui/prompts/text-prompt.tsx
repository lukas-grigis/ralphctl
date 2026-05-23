/**
 * Free-text input prompt. Uses Ink's `useInput` directly so the buffer mirrors the screen on
 * keystroke; cursor navigation (←/→, Home/End, ctrl+a/ctrl+e) is supported for mid-line editing.
 * Backspace removes the char before the cursor; Enter submits; Esc rejects with abort.
 *
 * A blinking caret signals "input is captured here"; a static one is easy to miss when the
 * prompt opens with a pre-filled `initial` value.
 *
 * Key bindings (shown in the hint row below the input):
 *   ↵ submit · ←/→ cursor · home/end edge · ctrl+a/ctrl+e edge · esc {escLabel} · ctrl+w word · ctrl+u clear
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface TextPromptProps {
  readonly message: string;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
  readonly initial?: string;
  /**
   * Label shown after `esc` in the hint row. Defaults to "cancel"; wizards that interpret Esc
   * as "step back" should pass "back" so the hint matches the actual behaviour.
   */
  readonly escLabel?: string;
}

export const TextPrompt = ({
  message,
  onSubmit,
  onCancel,
  initial = '',
  escLabel = 'cancel',
}: TextPromptProps): React.JSX.Element => {
  const [buf, setBuf] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [caretOn, setCaretOn] = useState(true);

  // Track buffer and cursor in refs so onSubmit/handlers read the latest values even when
  // multiple keystrokes arrive between renders (paste + Enter, ctrl+u + Enter, fast typing).
  const bufRef = useRef<string>(initial);
  const cursorRef = useRef<number>(initial.length);

  const updateCursor = (next: (prev: number) => number): void => {
    setCursor((prev) => {
      const value = next(prev);
      cursorRef.current = value;
      return value;
    });
  };

  // Atomically update both buf and cursor to avoid stale-closure races on rapid keystrokes.
  // The transform receives (prevBuf, prevCursor) and returns [newBuf, newCursor] so both values
  // are computed from a consistent snapshot without needing to read refs between calls.
  const updateBufAndCursor = (transform: (b: string, c: number) => [string, number]): void => {
    setBuf((prevBuf) => {
      const prevCursor = cursorRef.current;
      const [newBuf, newCursor] = transform(prevBuf, prevCursor);
      bufRef.current = newBuf;
      cursorRef.current = newCursor;
      setCursor(newCursor);
      return newBuf;
    });
  };

  // Half-second blink. The cleanup keeps the timer from leaking across remounts of the
  // wizards that key TextPrompts per step.
  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), 500);
    return () => {
      clearInterval(id);
    };
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(bufRef.current);
      return;
    }
    if (key.leftArrow) {
      updateCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      updateCursor((c) => Math.min(bufRef.current.length, c + 1));
      return;
    }
    // Home / ctrl+a — jump to start of buffer.
    if (key.home || (key.ctrl && input === 'a')) {
      updateCursor(() => 0);
      return;
    }
    // End / ctrl+e — jump to end of buffer.
    if (key.end || (key.ctrl && input === 'e')) {
      updateCursor(() => bufRef.current.length);
      return;
    }
    if (key.backspace || key.delete) {
      updateBufAndCursor((b, c) => {
        if (c === 0) return [b, c];
        return [b.slice(0, c - 1) + b.slice(c), c - 1];
      });
      return;
    }
    if (key.ctrl && input === 'u') {
      updateBufAndCursor(() => ['', 0]);
      return;
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
      return;
    }
    // Printable characters (including pasted multi-char input): insert at cursor.
    if (input.length > 0 && !key.meta && !key.ctrl && !key.tab) {
      const ins = input;
      updateBufAndCursor((b, c) => [b.slice(0, c) + ins + b.slice(c), c + ins.length]);
      return;
    }
    if (input.length > 0 && key.shift) {
      // shift+letter still produces a printable
      const ins = input;
      updateBufAndCursor((b, c) => [b.slice(0, c) + ins + b.slice(c), c + ins.length]);
    }
  });

  // Render the single input line with the caret at the cursor position.
  // When caretOn: block glyph replaces the char under the cursor (or trails the last char).
  // When caretOff: the char under the cursor renders normally so text is always legible.
  const beforeCursor = buf.slice(0, cursor);
  const charAtCursor = buf.slice(cursor, cursor + 1); // '' when cursor is past end
  const afterCursor = buf.slice(cursor + 1);

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
            <Text color={inkColors.highlight}>█</Text>
            <Text>{afterCursor}</Text>
          </>
        ) : (
          <>
            <Text>{charAtCursor.length > 0 ? charAtCursor : ' '}</Text>
            <Text>{afterCursor}</Text>
          </>
        )}
      </Box>
      <Text dimColor>↵ submit · ←/→ cursor · home/end edge · esc {escLabel} · ctrl+w word · ctrl+u clear</Text>
    </Box>
  );
};
