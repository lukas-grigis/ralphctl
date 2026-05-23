/**
 * Multi-line free-text input. Buffer holds raw text incl. newlines and renders one Ink row per
 * line. Cursor navigation (←/→/↑/↓, Home/End, ctrl+a/ctrl+e) is fully supported for mid-line
 * and multi-line editing. Newline insertion follows the convention familiar from Claude Code's
 * prompt — every key label below matches what the hint row at the bottom of the prompt shows
 * verbatim, so docs and UI stay in lockstep:
 *
 *   • ↵       → submit
 *   • \↵      → insert newline (the trailing backslash is consumed)
 *   • ctrl+j  → insert newline (terminal-native LF; useful when shells eat the backslash)
 *   • pasted text that already contains newlines → preserved verbatim
 *
 * Why not shift+↵? Most terminals can't distinguish shift+↵ from plain ↵ without Kitty / iTerm
 * CSI-u modes, and Ink's `useInput` flattens them. The \↵ chord is portable everywhere.
 *
 * Visual: the text rows live inside a rule-toned rounded border — same direction as the
 * `PromptHost` queued-prompt frame, just recessive so the typed content owns the contrast.
 * The "▸ message" header sits above the box; the chord-hint row sits below.
 *
 * Key bindings (shown in the hint row):
 *   ↵ submit · \↵ newline · ←/→/↑/↓ cursor · home/end edge · esc {escLabel} · ctrl+w word · ctrl+u clear
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

/** Resolve which line index and column the cursor offset maps to. */
const offsetToLineCol = (buf: string, offset: number): { line: number; col: number } => {
  const before = buf.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0 };
};

/** Resolve the flat offset from a line index + column (clamped to line length). */
const lineColToOffset = (buf: string, lineIdx: number, col: number): number => {
  const lines = buf.split('\n');
  // Sum lengths of all preceding lines plus their newline chars.
  let offset = 0;
  for (let i = 0; i < lineIdx && i < lines.length; i++) {
    offset += (lines[i]?.length ?? 0) + 1; // +1 for '\n'
  }
  const targetLine = lines[lineIdx] ?? '';
  offset += Math.min(col, targetLine.length);
  return offset;
};

export const TextAreaPrompt = ({
  message,
  onSubmit,
  onCancel,
  initial = '',
  escLabel = 'cancel',
}: TextAreaPromptProps): React.JSX.Element => {
  const [buf, setBuf] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [caretOn, setCaretOn] = useState(true);

  // Mirror buffer and cursor in refs so handlers read the latest values when keystrokes arrive
  // between renders (paste + Enter, ctrl+u + Enter, fast typing). Matches TextPrompt's pattern.
  const bufRef = useRef<string>(initial);
  const cursorRef = useRef<number>(initial.length);

  // desiredColumn: remembered column for ↑/↓ navigation through shorter lines.
  // Set to current column on any horizontal move or edit; preserved across up/down moves only.
  const desiredColRef = useRef<number | null>(null);

  // Atomically update both buf and cursor to avoid stale-closure races on rapid keystrokes.
  // The transform receives (prevBuf, prevCursor) and returns [newBuf, newCursor].
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

  const updateCursor = (next: (prev: number) => number): void => {
    setCursor((prev) => {
      const value = next(prev);
      cursorRef.current = value;
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
      const b = bufRef.current;
      // \↵ chord — strip the trailing backslash and insert a real newline at cursor.
      if (b.slice(0, cursorRef.current).endsWith('\\')) {
        updateBufAndCursor((b2, c) => {
          const newBuf = b2.slice(0, c - 1) + '\n' + b2.slice(c);
          return [newBuf, c]; // cursor stays after the newline (now pointing after the \n)
        });
        desiredColRef.current = null;
        return;
      }
      onSubmit(b);
      return;
    }
    if (key.leftArrow) {
      updateCursor((c) => Math.max(0, c - 1));
      desiredColRef.current = null;
      return;
    }
    if (key.rightArrow) {
      updateCursor((c) => Math.min(bufRef.current.length, c + 1));
      desiredColRef.current = null;
      return;
    }
    if (key.upArrow) {
      const b = bufRef.current;
      const c = cursorRef.current;
      const { line, col } = offsetToLineCol(b, c);
      const targetCol = desiredColRef.current ?? col;
      if (desiredColRef.current === null) desiredColRef.current = col;
      if (line === 0) {
        // Already on first line — jump to start.
        updateCursor(() => 0);
      } else {
        updateCursor(() => lineColToOffset(b, line - 1, targetCol));
      }
      return;
    }
    if (key.downArrow) {
      const b = bufRef.current;
      const c = cursorRef.current;
      const { line, col } = offsetToLineCol(b, c);
      const lines = b.split('\n');
      const targetCol = desiredColRef.current ?? col;
      if (desiredColRef.current === null) desiredColRef.current = col;
      if (line >= lines.length - 1) {
        // Already on last line — jump to end.
        updateCursor(() => b.length);
      } else {
        updateCursor(() => lineColToOffset(b, line + 1, targetCol));
      }
      return;
    }
    // Home / ctrl+a — jump to start of current line.
    if (key.home || (key.ctrl && input === 'a')) {
      const { line } = offsetToLineCol(bufRef.current, cursorRef.current);
      updateCursor(() => lineColToOffset(bufRef.current, line, 0));
      desiredColRef.current = 0;
      return;
    }
    // End / ctrl+e — jump to end of current line.
    if (key.end || (key.ctrl && input === 'e')) {
      const b = bufRef.current;
      const { line } = offsetToLineCol(b, cursorRef.current);
      const lineLen = b.split('\n')[line]?.length ?? 0;
      updateCursor(() => lineColToOffset(b, line, lineLen));
      desiredColRef.current = lineLen;
      return;
    }
    if (key.backspace || key.delete) {
      updateBufAndCursor((b, c) => {
        if (c === 0) return [b, c];
        return [b.slice(0, c - 1) + b.slice(c), c - 1];
      });
      desiredColRef.current = null;
      return;
    }
    if (key.ctrl && input === 'u') {
      updateBufAndCursor(() => ['', 0]);
      desiredColRef.current = null;
      return;
    }
    if (key.ctrl && input === 'w') {
      // Drop trailing whitespace (incl. newlines before cursor), then the preceding word.
      updateBufAndCursor((b, c) => {
        const before = b.slice(0, c);
        const after = b.slice(c);
        const trimmed = before.replace(/[\s\n]+$/u, '');
        const lastBoundary = trimmed.search(/\S+$/u);
        const newBefore = lastBoundary === -1 ? '' : trimmed.slice(0, lastBoundary);
        return [newBefore + after, newBefore.length];
      });
      desiredColRef.current = null;
      return;
    }
    // ctrl+j → newline at cursor. Some terminals send the LF byte instead of CR for this chord;
    // others surface it via `input === '\n'` with no ctrl flag. Handle both.
    if ((key.ctrl && input === 'j') || input === '\n') {
      updateBufAndCursor((b, c) => {
        const newBuf = b.slice(0, c) + '\n' + b.slice(c);
        return [newBuf, c + 1];
      });
      desiredColRef.current = null;
      return;
    }
    // Printable characters incl. pasted text. Paste may include `\n`; keep it.
    if (input.length > 0 && !key.meta && !key.ctrl && !key.tab) {
      const ins = input;
      updateBufAndCursor((b, c) => [b.slice(0, c) + ins + b.slice(c), c + ins.length]);
      desiredColRef.current = null;
    }
  });

  const lines = buf.split('\n');
  const { line: cursorLine, col: cursorCol } = offsetToLineCol(buf, cursor);

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
        {lines.map((line, i) => {
          const isActiveLine = i === cursorLine;
          return (
            <Box key={`row-${String(i)}`}>
              <Text dimColor>{i === 0 ? `${glyphs.arrowRight} ` : '  '}</Text>
              {isActiveLine ? (
                <>
                  <Text>{line.slice(0, cursorCol)}</Text>
                  {caretOn ? (
                    <>
                      <Text color={inkColors.highlight}>█</Text>
                      <Text>{line.slice(cursorCol + 1)}</Text>
                    </>
                  ) : (
                    <>
                      <Text>
                        {line.slice(cursorCol, cursorCol + 1).length > 0 ? line.slice(cursorCol, cursorCol + 1) : ' '}
                      </Text>
                      <Text>{line.slice(cursorCol + 1)}</Text>
                    </>
                  )}
                </>
              ) : (
                <Text>{line}</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Text dimColor>
        ↵ submit · \↵ newline · ←/→/↑/↓ cursor · home/end edge · esc {escLabel} · ctrl+w word · ctrl+u clear
      </Text>
    </Box>
  );
};
