/**
 * Claude Code-style inline multi-line text editor.
 *
 * Keybindings:
 * - Printable chars         Insert at cursor
 * - Enter                   Insert newline
 * - Ctrl+D                  Submit
 * - Escape / Ctrl+C         Cancel (resolves to null)
 * - Backspace               Delete char before cursor
 * - Left / Right            Move cursor
 * - Up / Down               Move cursor across lines
 * - Ctrl+A                  Start of line
 * - Ctrl+E                  End of line
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EditorOptions } from '../../../business/ports/prompt-port.ts';
import { glyphs, inkColors } from '../theme/tokens.ts';

interface EditorPromptProps {
  options: EditorOptions;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

interface CursorState {
  row: number;
  col: number;
}

const MIN_EDIT_ROWS = 8;

function splitLines(text: string): string[] {
  return text.split('\n');
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

function clampCursor(lines: string[], cursor: CursorState): CursorState {
  const row = Math.max(0, Math.min(cursor.row, lines.length - 1));
  const line = lines[row] ?? '';
  const col = Math.max(0, Math.min(cursor.col, line.length));
  return { row, col };
}

export function EditorPrompt({ options, onSubmit, onCancel }: EditorPromptProps): React.JSX.Element {
  const [lines, setLines] = useState<string[]>(() => splitLines(options.default ?? ''));
  const [cursor, setCursor] = useState<CursorState>(() => {
    const init = splitLines(options.default ?? '');
    const lastRow = init.length - 1;
    return { row: lastRow, col: (init[lastRow] ?? '').length };
  });

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
      return;
    }
    if (key.ctrl && input === 'd') {
      onSubmit(joinLines(lines));
      return;
    }
    if (key.leftArrow) {
      setCursor((prev) => {
        if (prev.col > 0) return { row: prev.row, col: prev.col - 1 };
        if (prev.row > 0) {
          const up = lines[prev.row - 1] ?? '';
          return { row: prev.row - 1, col: up.length };
        }
        return prev;
      });
      return;
    }
    if (key.rightArrow) {
      setCursor((prev) => {
        const curLine = lines[prev.row] ?? '';
        if (prev.col < curLine.length) return { row: prev.row, col: prev.col + 1 };
        if (prev.row < lines.length - 1) return { row: prev.row + 1, col: 0 };
        return prev;
      });
      return;
    }
    if (key.upArrow) {
      setCursor((prev) => clampCursor(lines, { row: prev.row - 1, col: prev.col }));
      return;
    }
    if (key.downArrow) {
      setCursor((prev) => clampCursor(lines, { row: prev.row + 1, col: prev.col }));
      return;
    }
    if (key.ctrl && input === 'a') {
      setCursor((prev) => ({ row: prev.row, col: 0 }));
      return;
    }
    if (key.ctrl && input === 'e') {
      setCursor((prev) => {
        const curLine = lines[prev.row] ?? '';
        return { row: prev.row, col: curLine.length };
      });
      return;
    }
    if (key.backspace || key.delete) {
      setLines((prev) => {
        const next = [...prev];
        const line = next[cursor.row] ?? '';
        if (cursor.col > 0) {
          next[cursor.row] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
          setCursor({ row: cursor.row, col: cursor.col - 1 });
        } else if (cursor.row > 0) {
          const prevLine = next[cursor.row - 1] ?? '';
          const mergedCol = prevLine.length;
          next[cursor.row - 1] = prevLine + line;
          next.splice(cursor.row, 1);
          setCursor({ row: cursor.row - 1, col: mergedCol });
        }
        return next;
      });
      return;
    }
    if (key.return) {
      setLines((prev) => {
        const next = [...prev];
        const line = next[cursor.row] ?? '';
        const before = line.slice(0, cursor.col);
        const after = line.slice(cursor.col);
        next[cursor.row] = before;
        next.splice(cursor.row + 1, 0, after);
        return next;
      });
      setCursor({ row: cursor.row + 1, col: 0 });
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const chunk = input;
      setLines((prev) => {
        const next = [...prev];
        const line = next[cursor.row] ?? '';
        const before = line.slice(0, cursor.col);
        const after = line.slice(cursor.col);
        const parts = (before + chunk + after).split('\n');
        next.splice(cursor.row, 1, ...parts);
        const insertedLines = chunk.split('\n');
        const insertedRow = cursor.row + insertedLines.length - 1;
        const insertedCol =
          insertedLines.length === 1
            ? before.length + chunk.length
            : (insertedLines[insertedLines.length - 1] ?? '').length;
        setCursor({ row: insertedRow, col: insertedCol });
        return next;
      });
    }
  });

  const renderedLines = useMemo(() => {
    const padCount = Math.max(0, MIN_EDIT_ROWS - lines.length);
    const padded: (string | { before: string; at: string; after: string })[] = lines.map((line, i) => {
      if (i !== cursor.row) return line.length > 0 ? line : ' ';
      const before = line.slice(0, cursor.col);
      const at = line[cursor.col] ?? ' ';
      const after = line.slice(cursor.col + 1);
      return { before, at, after };
    });
    for (let i = 0; i < padCount; i++) padded.push(' ');
    return padded;
  }, [lines, cursor]);

  const charCount = lines.reduce((sum, l) => sum + l.length, 0);
  const lineCount = lines.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={inkColors.muted} paddingX={1} width="100%">
      <Box>
        <Text color={inkColors.primary} bold>
          {glyphs.badge}
        </Text>
        <Text color={inkColors.primary} bold>{` ${options.message.toUpperCase()}`}</Text>
      </Box>
      <Box marginTop={1} marginLeft={1} flexDirection="column">
        {renderedLines.map((item, i) => {
          if (typeof item === 'string') {
            return (
              <Text key={i} dimColor={i >= lines.length}>
                {item}
              </Text>
            );
          }
          return (
            <Text key={i}>
              {item.before}
              <Text inverse>{item.at}</Text>
              {item.after}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor>
          Ctrl+D submit {glyphs.inlineDot} Esc cancel {glyphs.inlineDot} Enter newline
        </Text>
        <Text dimColor>
          {String(lineCount)} {lineCount === 1 ? 'line' : 'lines'} {glyphs.inlineDot} {String(charCount)}{' '}
          {charCount === 1 ? 'char' : 'chars'}
        </Text>
      </Box>
    </Box>
  );
}
