/**
 * Multi-line free-text input. Buffer holds raw text incl. newlines and renders one Ink row per
 * line. Newline insertion follows the convention familiar from Claude Code's prompt — every key
 * label below matches what the hint row at the bottom of the prompt shows verbatim, so docs and
 * UI stay in lockstep:
 *
 *   • ↵       → submit
 *   • \↵      → insert newline (the trailing backslash is consumed)
 *   • ctrl+j  → insert newline (terminal-native LF; useful when shells eat the backslash)
 *   • pasted text that already contains newlines → preserved verbatim
 *
 * Mid-line editing isn't supported (no arrow-key cursor) — backspace removes the trailing char,
 * including a newline that collapses two lines. Same scope as TextPrompt, just two-dimensional.
 *
 * Why not shift+↵? Most terminals can't distinguish shift+↵ from plain ↵ without Kitty / iTerm
 * CSI-u modes, and Ink's `useInput` flattens them. The \↵ chord is portable everywhere.
 *
 * Visual: the text rows live inside a rule-toned rounded border — same direction as the
 * `PromptHost` queued-prompt frame, just recessive so the typed content owns the contrast.
 * The "▸ message" header sits above the box; the chord-hint row sits below.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface TextAreaPromptProps {
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

export const TextAreaPrompt = ({
  message,
  onSubmit,
  onCancel,
  initial = '',
  escLabel = 'cancel',
}: TextAreaPromptProps): React.JSX.Element => {
  const [buf, setBuf] = useState(initial);
  const [caretOn, setCaretOn] = useState(true);

  // Mirror buffer in a ref so onSubmit reads the latest value when keystrokes arrive between
  // renders (paste + Enter, ctrl+u + Enter, fast typing). Matches TextPrompt's pattern.
  const bufRef = useRef<string>(initial);
  const updateBuf = (next: (prev: string) => string): void => {
    setBuf((prev) => {
      const value = next(prev);
      bufRef.current = value;
      return value;
    });
  };

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
      // \↵ chord — strip the trailing backslash and turn the line break into a real newline.
      if (bufRef.current.endsWith('\\')) {
        updateBuf((b) => `${b.slice(0, -1)}\n`);
        return;
      }
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
      // Drop trailing whitespace (incl. newlines), then the preceding word.
      updateBuf((b) => {
        const trimmed = b.replace(/[\s\n]+$/u, '');
        const lastBoundary = trimmed.search(/\S+$/u);
        return lastBoundary === -1 ? '' : trimmed.slice(0, lastBoundary);
      });
      return;
    }
    // ctrl+j → newline. Some terminals send the LF byte instead of CR for this chord; others
    // surface it via `input === '\n'` with no ctrl flag. Handle both.
    if ((key.ctrl && input === 'j') || input === '\n') {
      updateBuf((b) => `${b}\n`);
      return;
    }
    // Printable characters incl. pasted text. Paste may include `\n`; keep it.
    if (input.length > 0 && !key.meta && !key.ctrl && !key.tab) {
      updateBuf((b) => b + input);
    }
  });

  const lines = buf.split('\n');
  const lastIndex = lines.length - 1;

  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Text color={inkColors.primary} bold>
        {glyphs.actionCursor} {message}
      </Text>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={inkColors.rule}
        borderDimColor
        paddingX={spacing.cardPadX}
        paddingY={0}
        marginTop={spacing.gutter}
        marginBottom={spacing.gutter}
      >
        {lines.map((line, i) => (
          <Box key={`row-${String(i)}`}>
            <Text dimColor>{i === 0 ? `${glyphs.arrowRight} ` : '  '}</Text>
            <Text>{line}</Text>
            {i === lastIndex && <Text color={inkColors.highlight}>{caretOn ? '█' : ' '}</Text>}
          </Box>
        ))}
      </Box>
      <Text dimColor>↵ submit · \↵ newline · esc {escLabel} · ctrl+w word · ctrl+u clear</Text>
    </Box>
  );
};
