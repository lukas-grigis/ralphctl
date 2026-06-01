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
 * Viewport: long bodies render through a cursor-following window. A row budget is derived from
 * the terminal height minus a chrome reserve; when the buffer overflows it, the visible lines are
 * sliced so the cursor's line — and the hint row below the field — always stay on screen, and a
 * dim cue marks any content hidden above / below the window. When the whole buffer fits, every
 * line renders with no slicing and no cue — byte-for-byte the short-body behaviour.
 *
 * Key bindings (shown in the hint row):
 *   ↵ submit · \↵ newline · ←/→/↑/↓ cursor · home/end edge · esc {escLabel} · ctrl+w word · ctrl+u clear
 *   (pgup/pgdn jump roughly a screenful, scrolling the window at the edges)
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';

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

/**
 * Reserve rows for the chrome around the editable text window — the prompt header above the
 * field, the rounded border, the marginTop / marginBottom gutters, the keyboard-hint row below,
 * the hidden-content cues, plus the surrounding prompt-host / breadcrumb / status chrome. Mirrors
 * the reserve approach used by the review-step scrollable description; the floor keeps a tiny
 * terminal usable — the field always shows a few rows even when the reserve would zero it out.
 */
const TEXT_AREA_CHROME_ROWS = 14;
const TEXT_AREA_MIN_VIEWPORT = 4;

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

/**
 * Shift the window offset so the cursor's line stays inside it, preserving the previous offset
 * (hysteresis) when the cursor is already visible. Clamped to [0, lastPossibleOffset] with no
 * wrap-around — at the extremes the window simply stops.
 */
const followCursorOffset = (prevOffset: number, cursorLine: number, viewport: number, totalLines: number): number => {
  const maxOffset = Math.max(0, totalLines - viewport);
  let next = prevOffset;
  if (cursorLine < next) next = cursorLine;
  else if (cursorLine > next + viewport - 1) next = cursorLine - viewport + 1;
  return Math.max(0, Math.min(next, maxOffset));
};

/**
 * Detect an xterm SGR mouse report (e.g. ESC[<65;10;10M). The field is keyboard-only, but a wheel
 * event can leak onto stdin while mouse-tracking is being torn down for a prompt; Ink strips the
 * leading ESC, leaving "[<…M"/"[<…m" — all-printable ASCII that would otherwise be typed into the
 * buffer. Reject it so stray wheel bytes never become text.
 */
const isMouseReport = (input: string): boolean => {
  const stripped = input.startsWith(String.fromCharCode(27)) ? input.slice(1) : input;
  return /^\[<\d+;\d+;\d+[Mm]$/.test(stripped);
};

export const TextAreaPrompt = ({
  message,
  onSubmit,
  onCancel,
  initial = '',
  escLabel = 'cancel',
}: TextAreaPromptProps): React.JSX.Element => {
  const term = useTerminalSize();
  const [buf, setBuf] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [caretOn, setCaretOn] = useState(true);
  // First buffer line shown in the window. Persisted so the window keeps its position
  // (hysteresis) as the cursor moves within it; the render derives the effective offset from it.
  const [firstVisible, setFirstVisible] = useState(0);

  // Mirror buffer and cursor in refs so handlers read the latest values when keystrokes arrive
  // between renders (paste + Enter, ctrl+u + Enter, fast typing). Matches TextPrompt's pattern.
  const bufRef = useRef<string>(initial);
  const cursorRef = useRef<number>(initial.length);

  // desiredColumn: remembered column for ↑/↓ navigation through shorter lines.
  // Set to current column on any horizontal move or edit; preserved across up/down moves only.
  const desiredColRef = useRef<number | null>(null);

  // Atomically update both buf and cursor to avoid stale-closure races on rapid keystrokes. The
  // refs are the synchronous source of truth: write them immediately so a keystroke that arrives
  // before React flushes (paste + Enter, fast typing) still reads the latest value. Subscribing
  // to terminal-size context defers React's commit, so the refs must not depend on the setState
  // updater running synchronously — they are updated here, then mirrored into render state.
  const updateBufAndCursor = (transform: (b: string, c: number) => [string, number]): void => {
    const [newBuf, newCursor] = transform(bufRef.current, cursorRef.current);
    bufRef.current = newBuf;
    cursorRef.current = newCursor;
    setBuf(newBuf);
    setCursor(newCursor);
  };

  const updateCursor = (next: (prev: number) => number): void => {
    const value = next(cursorRef.current);
    cursorRef.current = value;
    setCursor(value);
  };

  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), 500);
    return () => {
      clearInterval(id);
    };
  }, []);

  const lines = buf.split('\n');
  const { line: cursorLine, col: cursorCol } = offsetToLineCol(buf, cursor);
  const viewport = Math.max(TEXT_AREA_MIN_VIEWPORT, term.rows - TEXT_AREA_CHROME_ROWS);
  const overflows = lines.length > viewport;
  // Effective window offset for this render — always contains the cursor line, so the caret and
  // the hint row below stay on screen no matter how the cursor moved (edit, arrow, paste, page).
  const windowStart = overflows ? followCursorOffset(firstVisible, cursorLine, viewport, lines.length) : 0;

  // Persist the followed offset so the next interaction keeps the window where it settled. This
  // is idempotent once the cursor is inside the window, so it cannot loop.
  useEffect(() => {
    if (firstVisible !== windowStart) setFirstVisible(windowStart);
  }, [firstVisible, windowStart]);

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
      const bufLines = b.split('\n');
      const targetCol = desiredColRef.current ?? col;
      if (desiredColRef.current === null) desiredColRef.current = col;
      if (line >= bufLines.length - 1) {
        // Already on last line — jump to end.
        updateCursor(() => b.length);
      } else {
        updateCursor(() => lineColToOffset(b, line + 1, targetCol));
      }
      return;
    }
    // PgDn / PgUp — move the cursor roughly a screenful; the window follows so the net effect is
    // a page scroll. Clamped to the buffer's first / last line, no wrap-around.
    if (key.pageDown) {
      const b = bufRef.current;
      const { line, col } = offsetToLineCol(b, cursorRef.current);
      const total = b.split('\n').length;
      const targetCol = desiredColRef.current ?? col;
      if (desiredColRef.current === null) desiredColRef.current = col;
      updateCursor(() => lineColToOffset(b, Math.min(total - 1, line + viewport), targetCol));
      return;
    }
    if (key.pageUp) {
      const b = bufRef.current;
      const { line, col } = offsetToLineCol(b, cursorRef.current);
      const targetCol = desiredColRef.current ?? col;
      if (desiredColRef.current === null) desiredColRef.current = col;
      updateCursor(() => lineColToOffset(b, Math.max(0, line - viewport), targetCol));
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
    // Printable characters incl. pasted text. Paste may include `\n`; keep it. Mouse SGR reports
    // are rejected — the field is keyboard-only and a leaked wheel event must not type stray bytes.
    if (input.length > 0 && !key.meta && !key.ctrl && !key.tab && !isMouseReport(input)) {
      const ins = input;
      updateBufAndCursor((b, c) => [b.slice(0, c) + ins + b.slice(c), c + ins.length]);
      desiredColRef.current = null;
    }
  });

  const visible = overflows ? lines.slice(windowStart, windowStart + viewport) : lines;
  const hasAbove = overflows && windowStart > 0;
  const hasBelow = overflows && windowStart + viewport < lines.length;

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
        {hasAbove ? <Text dimColor>{`  ${glyphs.clipEllipsis}`}</Text> : null}
        {visible.map((line, i) => {
          const absoluteIndex = windowStart + i;
          const isActiveLine = absoluteIndex === cursorLine;
          return (
            <Box key={`row-${String(absoluteIndex)}`}>
              <Text dimColor>{absoluteIndex === 0 ? `${glyphs.arrowRight} ` : '  '}</Text>
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
        {hasBelow ? <Text dimColor>{`  ${glyphs.clipEllipsis}`}</Text> : null}
      </Box>
      <Text dimColor>
        ↵ submit · \↵ newline · ←/→/↑/↓ cursor · home/end edge · esc {escLabel} · ctrl+w word · ctrl+u clear
      </Text>
    </Box>
  );
};
