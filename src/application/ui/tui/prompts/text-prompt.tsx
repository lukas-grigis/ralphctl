/**
 * Free-text input prompt. Uses Ink's `useInput` directly so the buffer mirrors the screen on
 * keystroke; backspace removes the last char, Enter submits, Esc rejects with abort. Mid-line
 * editing isn't supported (no cursor) — the chain layer wraps this for high-frequency input
 * patterns where that matters.
 *
 * A blinking caret signals "input is captured here"; a static one is easy to miss when the
 * prompt opens with a pre-filled `initial` value.
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
  const [caretOn, setCaretOn] = useState(true);

  // Track the buffer in a ref alongside state so onSubmit reads the latest value even when
  // multiple keystrokes arrive between renders (paste + Enter, ctrl+u + Enter, fast typing).
  // The setState closure value can lag behind the queue.
  const bufRef = useRef<string>(initial);
  const updateBuf = (next: (prev: string) => string): void => {
    setBuf((prev) => {
      const value = next(prev);
      bufRef.current = value;
      return value;
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
    if (key.backspace || key.delete) {
      updateBuf((b) => b.slice(0, -1));
      return;
    }
    if (key.ctrl && input === 'u') {
      updateBuf(() => '');
      return;
    }
    if (key.ctrl && input === 'w') {
      // Drop trailing whitespace, then the preceding word — conventional shell behaviour.
      updateBuf((b) => {
        const trimmed = b.replace(/\s+$/u, '');
        const lastBoundary = trimmed.search(/\S+$/u);
        return lastBoundary === -1 ? '' : trimmed.slice(0, lastBoundary);
      });
      return;
    }
    // Skip arrow keys and other non-printables; keep printable chars only.
    if (input.length > 0 && !key.meta && !key.ctrl && !key.shift && !key.tab) {
      updateBuf((b) => b + input);
      return;
    }
    if (input.length > 0 && key.shift) {
      // shift+letter still produces a printable
      updateBuf((b) => b + input);
    }
  });

  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text color={inkColors.primary} bold>
        {glyphs.actionCursor} {message}
      </Text>
      <Box>
        <Text dimColor>{glyphs.arrowRight} </Text>
        <Text>{buf}</Text>
        <Text color={inkColors.highlight}>{caretOn ? '█' : ' '}</Text>
      </Box>
      <Text dimColor>↵ submit · esc {escLabel} · ctrl+w word · ctrl+u clear</Text>
    </Box>
  );
};
