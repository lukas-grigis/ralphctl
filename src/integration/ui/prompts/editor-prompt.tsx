/**
 * Claude Code-style inline multi-line text editor (REQ-9).
 *
 * Keybindings:
 * - Printable chars                     Insert at cursor
 * - Enter                               Insert newline
 * - Return (standalone, no shift)       Same as Enter — multi-line buffer
 * - Ctrl+D                              Submit
 * - Escape                              Cancel (resolves to null)
 * - Backspace                           Delete char before cursor
 * - Delete                              Delete char at cursor
 * - Left / Right                        Move cursor
 * - Up / Down                           Move cursor across lines
 * - Home / Ctrl+A                       Start of line
 * - End  / Ctrl+E                       End of line
 * - Ctrl+C                              Cancel (same as Escape)
 *
 * Goal: feel like typing into Claude Code. Submit is Ctrl+D rather than plain
 * Enter because Enter inserts a newline — this matches terminal multi-line
 * editor norms (nano, heredocs) and avoids accidental submits.
 *
 * Visual: rounded border + section-stamp header + a fixed minimum height
 * (8 rows of edit area) + a live `lines · chars` counter in the footer —
 * gives the input room to breathe even for short text, and a readable
 * character budget for longer descriptions.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EditorOptions } from '@src/business/ports/prompt.ts';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

export interface EditorPromptProps {
  options: EditorOptions;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

interface CursorState {
  row: number;
  col: number;
}

/** Minimum visible rows for the edit area — gives room even when empty. */
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

  // Pad visible buffer to the minimum row count so the edit area always has
  // visual "room" — encourages longer prose without feeling cramped.
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

  // Live counter: lines and total characters (excluding newlines for honesty).
  const charCount = lines.reduce((sum, l) => sum + l.length, 0);
  const lineCount = lines.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={inkColors.muted} paddingX={1}>
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
        <Text dimColor>Ctrl+D submit · Esc cancel · Enter newline</Text>
        <Text dimColor>
          {String(lineCount)} {lineCount === 1 ? 'line' : 'lines'} {glyphs.inlineDot} {String(charCount)}{' '}
          {charCount === 1 ? 'char' : 'chars'}
        </Text>
      </Box>
    </Box>
  );
}
