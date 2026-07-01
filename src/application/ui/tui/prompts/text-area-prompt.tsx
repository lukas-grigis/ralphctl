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

import React, { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { normalizePasteNewlines, stripPasteMarkers, usePaste } from '@src/application/ui/tui/prompts/use-paste.ts';

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

/** Move one line up/down (`dir` -1/+1), jumping to the buffer's start/end at either edge. */
const verticalMoveOffset = (buf: string, line: number, targetCol: number, dir: -1 | 1): number => {
  if (dir === -1) {
    if (line === 0) return 0;
    return lineColToOffset(buf, line - 1, targetCol);
  }
  const totalLines = buf.split('\n').length;
  if (line >= totalLines - 1) return buf.length;
  return lineColToOffset(buf, line + 1, targetCol);
};

/** Move roughly a screenful up/down (`dir` -1/+1), clamped to the buffer's first/last line. */
const pageMoveOffset = (buf: string, line: number, targetCol: number, viewport: number, dir: -1 | 1): number => {
  if (dir === -1) return lineColToOffset(buf, Math.max(0, line - viewport), targetCol);
  const total = buf.split('\n').length;
  return lineColToOffset(buf, Math.min(total - 1, line + viewport), targetCol);
};

/**
 * Derive the window of buffer lines to render this render pass: which lines are visible, whether
 * content is hidden above/below the window, and where the cursor sits within it. `firstVisible`
 * is the persisted window offset (hysteresis); when the whole buffer fits, the window collapses
 * to showing every line with no slicing and no cue — byte-for-byte the short-body behaviour.
 */
interface TextAreaViewportState {
  readonly cursorLine: number;
  readonly cursorCol: number;
  readonly viewport: number;
  readonly windowStart: number;
  readonly visible: readonly string[];
  readonly hasAbove: boolean;
  readonly hasBelow: boolean;
}

const computeViewportState = (
  buf: string,
  cursor: number,
  termRows: number,
  firstVisible: number
): TextAreaViewportState => {
  const lines = buf.split('\n');
  const { line: cursorLine, col: cursorCol } = offsetToLineCol(buf, cursor);
  const viewport = Math.max(TEXT_AREA_MIN_VIEWPORT, termRows - TEXT_AREA_CHROME_ROWS);
  const overflows = lines.length > viewport;
  // Effective window offset for this render — always contains the cursor line, so the caret and
  // the hint row below stay on screen no matter how the cursor moved (edit, arrow, paste, page).
  const windowStart = overflows ? followCursorOffset(firstVisible, cursorLine, viewport, lines.length) : 0;
  const visible = overflows ? lines.slice(windowStart, windowStart + viewport) : lines;
  const hasAbove = overflows && windowStart > 0;
  const hasBelow = overflows && windowStart + viewport < lines.length;
  return { cursorLine, cursorCol, viewport, windowStart, visible, hasAbove, hasBelow };
};

/** Bundle of refs/callbacks the `useInput` key-dispatch groups below need to read or mutate. */
interface TextAreaKeyCtx {
  readonly bufRef: MutableRefObject<string>;
  readonly cursorRef: MutableRefObject<number>;
  readonly desiredColRef: MutableRefObject<number | null>;
  readonly viewport: number;
  readonly updateCursor: (next: (prev: number) => number) => void;
  readonly updateBufAndCursor: (transform: (b: string, c: number) => [string, number]) => void;
  readonly insertAtCursor: (text: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

/**
 * Resolve the cursor's current line + the "remembered" column for ↑/↓/PgUp/PgDn navigation.
 * Seeds `desiredColRef` from the current column on first use so a run of vertical moves keeps
 * tracking the original column through shorter lines, until a horizontal move or edit clears it.
 */
const resolveDesiredCol = (ctx: TextAreaKeyCtx): { line: number; targetCol: number } => {
  const { line, col } = offsetToLineCol(ctx.bufRef.current, ctx.cursorRef.current);
  const targetCol = ctx.desiredColRef.current ?? col;
  if (ctx.desiredColRef.current === null) ctx.desiredColRef.current = col;
  return { line, targetCol };
};

/**
 * Escape / Enter chords — cancel, the \↵ newline-insert convention, and plain-Enter submit.
 * Always handled (returns true) when reached — the caller has already consumed paste bytes.
 */
const handleControlKeys = (_input: string, key: Key, ctx: TextAreaKeyCtx): boolean => {
  if (key.escape) {
    ctx.onCancel();
    return true;
  }
  if (key.return) {
    const b = ctx.bufRef.current;
    // \↵ chord — strip the trailing backslash and insert a real newline at cursor.
    if (b.slice(0, ctx.cursorRef.current).endsWith('\\')) {
      ctx.updateBufAndCursor((b2, c) => {
        const newBuf = b2.slice(0, c - 1) + '\n' + b2.slice(c);
        return [newBuf, c]; // cursor stays after the newline (now pointing after the \n)
      });
      ctx.desiredColRef.current = null;
      return true;
    }
    ctx.onSubmit(b);
    return true;
  }
  return false;
};

/**
 * Cursor-navigation chords: arrows, Home/End (+ ctrl+a/ctrl+e aliases), PgUp/PgDn. Vertical and
 * page moves share desiredColumn tracking via {@link resolveDesiredCol} so both ↑/↓ and PgUp/PgDn
 * remember the column through shorter lines.
 */
const handleCursorMovement = (input: string, key: Key, ctx: TextAreaKeyCtx): boolean => {
  if (key.leftArrow) {
    ctx.updateCursor((c) => Math.max(0, c - 1));
    ctx.desiredColRef.current = null;
    return true;
  }
  if (key.rightArrow) {
    ctx.updateCursor((c) => Math.min(ctx.bufRef.current.length, c + 1));
    ctx.desiredColRef.current = null;
    return true;
  }
  if (key.upArrow) {
    const { line, targetCol } = resolveDesiredCol(ctx);
    ctx.updateCursor(() => verticalMoveOffset(ctx.bufRef.current, line, targetCol, -1));
    return true;
  }
  if (key.downArrow) {
    const { line, targetCol } = resolveDesiredCol(ctx);
    ctx.updateCursor(() => verticalMoveOffset(ctx.bufRef.current, line, targetCol, 1));
    return true;
  }
  // PgDn / PgUp — move the cursor roughly a screenful; the window follows so the net effect is
  // a page scroll. Clamped to the buffer's first / last line, no wrap-around.
  if (key.pageDown) {
    const { line, targetCol } = resolveDesiredCol(ctx);
    ctx.updateCursor(() => pageMoveOffset(ctx.bufRef.current, line, targetCol, ctx.viewport, 1));
    return true;
  }
  if (key.pageUp) {
    const { line, targetCol } = resolveDesiredCol(ctx);
    ctx.updateCursor(() => pageMoveOffset(ctx.bufRef.current, line, targetCol, ctx.viewport, -1));
    return true;
  }
  // Home / ctrl+a — jump to start of current line.
  if (key.home || (key.ctrl && input === 'a')) {
    const { line } = offsetToLineCol(ctx.bufRef.current, ctx.cursorRef.current);
    ctx.updateCursor(() => lineColToOffset(ctx.bufRef.current, line, 0));
    ctx.desiredColRef.current = 0;
    return true;
  }
  // End / ctrl+e — jump to end of current line.
  if (key.end || (key.ctrl && input === 'e')) {
    const b = ctx.bufRef.current;
    const { line } = offsetToLineCol(b, ctx.cursorRef.current);
    const lineLen = b.split('\n')[line]?.length ?? 0;
    ctx.updateCursor(() => lineColToOffset(b, line, lineLen));
    ctx.desiredColRef.current = lineLen;
    return true;
  }
  return false;
};

/**
 * Buffer-mutating chords: delete/backspace, ctrl+u (clear), ctrl+w (delete word), ctrl+j / literal
 * `\n` (newline insert), and finally plain printable/pasted-text insertion at the cursor. Reached
 * only once control keys and cursor movement have both declined the keystroke, so it dispatches
 * unconditionally instead of returning a handled flag.
 */
const handleTextEditing = (input: string, key: Key, ctx: TextAreaKeyCtx): void => {
  if (key.backspace || key.delete) {
    ctx.updateBufAndCursor((b, c) => {
      if (c === 0) return [b, c];
      return [b.slice(0, c - 1) + b.slice(c), c - 1];
    });
    ctx.desiredColRef.current = null;
    return;
  }
  if (key.ctrl && input === 'u') {
    ctx.updateBufAndCursor(() => ['', 0]);
    ctx.desiredColRef.current = null;
    return;
  }
  if (key.ctrl && input === 'w') {
    // Drop trailing whitespace (incl. newlines before cursor), then the preceding word.
    ctx.updateBufAndCursor((b, c) => {
      const before = b.slice(0, c);
      const after = b.slice(c);
      const trimmed = before.replace(/[\s\n]+$/u, '');
      const lastBoundary = trimmed.search(/\S+$/u);
      const newBefore = lastBoundary === -1 ? '' : trimmed.slice(0, lastBoundary);
      return [newBefore + after, newBefore.length];
    });
    ctx.desiredColRef.current = null;
    return;
  }
  // ctrl+j → newline at cursor. Some terminals send the LF byte instead of CR for this chord;
  // others surface it via `input === '\n'` with no ctrl flag. Handle both.
  if ((key.ctrl && input === 'j') || input === '\n') {
    ctx.updateBufAndCursor((b, c) => {
      const newBuf = b.slice(0, c) + '\n' + b.slice(c);
      return [newBuf, c + 1];
    });
    ctx.desiredColRef.current = null;
    return;
  }
  // Printable characters incl. pasted text. Mouse SGR reports are rejected — the field is
  // keyboard-only and a leaked wheel event must not type stray bytes. Fallback for terminals
  // that don't honour mode 2004: a single-chunk paste lands here, so strip any stray paste
  // markers and normalize `\r\n`/`\r` → `\n` before inserting (kept multi-line, never submit).
  if (input.length > 0 && !key.meta && !key.ctrl && !key.tab && !isMouseReport(input)) {
    const ins = normalizePasteNewlines(stripPasteMarkers(input));
    ctx.insertAtCursor(ins);
  }
};

/** Blink the caret every 500ms for as long as the field is mounted. */
const useCaretBlink = (setCaretOn: (next: (prev: boolean) => boolean) => void): void => {
  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), 500);
    return () => {
      clearInterval(id);
    };
  }, [setCaretOn]);
};

/**
 * Derive this render's viewport state and persist the followed window offset so the next
 * interaction keeps the window where it settled. The persistence effect is idempotent once the
 * cursor is inside the window, so it cannot loop.
 */
const useTextAreaViewport = (
  buf: string,
  cursor: number,
  termRows: number,
  firstVisible: number,
  setFirstVisible: (next: number) => void
): TextAreaViewportState => {
  const state = computeViewportState(buf, cursor, termRows, firstVisible);
  useEffect(() => {
    if (firstVisible !== state.windowStart) setFirstVisible(state.windowStart);
  }, [firstVisible, state.windowStart, setFirstVisible]);
  return state;
};

/**
 * Wire the three key-dispatch groups into Ink's `useInput`. Bracketed paste is consumed first so
 * its bytes and embedded line breaks never reach the dispatch groups — no premature submit.
 */
const useTextAreaKeyHandler = (ctx: TextAreaKeyCtx, consumePaste: (input: string) => boolean): void => {
  useInput((input, key) => {
    if (consumePaste(input)) return;
    if (handleControlKeys(input, key, ctx)) return;
    if (handleCursorMovement(input, key, ctx)) return;
    handleTextEditing(input, key, ctx);
  });
};

interface TextAreaRowProps {
  readonly line: string;
  readonly absoluteIndex: number;
  readonly isActiveLine: boolean;
  readonly cursorCol: number;
  readonly caretOn: boolean;
}

/** One rendered line of the text area — the leading marker/caret column plus the line's text. */
const TextAreaRow = ({
  line,
  absoluteIndex,
  isActiveLine,
  cursorCol,
  caretOn,
}: TextAreaRowProps): React.JSX.Element => (
  <Box>
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
            <Text>{line.slice(cursorCol, cursorCol + 1).length > 0 ? line.slice(cursorCol, cursorCol + 1) : ' '}</Text>
            <Text>{line.slice(cursorCol + 1)}</Text>
          </>
        )}
      </>
    ) : (
      <Text>{line}</Text>
    )}
  </Box>
);

interface TextAreaFrameProps {
  readonly message: string;
  readonly escLabel: string;
  readonly hasAbove: boolean;
  readonly hasBelow: boolean;
  readonly visible: readonly string[];
  readonly windowStart: number;
  readonly cursorLine: number;
  readonly cursorCol: number;
  readonly caretOn: boolean;
}

/** The header line, the bordered viewport (rows + hidden-content cues), and the hint row. */
const TextAreaFrame = ({
  message,
  escLabel,
  hasAbove,
  hasBelow,
  visible,
  windowStart,
  cursorLine,
  cursorCol,
  caretOn,
}: TextAreaFrameProps): React.JSX.Element => (
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
          <TextAreaRow
            key={`row-${String(absoluteIndex)}`}
            line={line}
            absoluteIndex={absoluteIndex}
            isActiveLine={isActiveLine}
            cursorCol={cursorCol}
            caretOn={caretOn}
          />
        );
      })}
      {hasBelow ? <Text dimColor>{`  ${glyphs.clipEllipsis}`}</Text> : null}
    </Box>
    <Text dimColor>
      ↵ submit · \↵ newline · ←/→/↑/↓ cursor · home/end edge · esc {escLabel} · ctrl+w word · ctrl+u clear
    </Text>
  </Box>
);

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

  // Insert literal pasted text at the cursor, newlines preserved. A pasted newline is never a
  // submit — that ambiguity is exactly why bracketed paste exists. Routed through the same
  // updateBufAndCursor seam so the refs stay the synchronous source of truth.
  const insertAtCursor = (text: string): void => {
    if (text.length === 0) return;
    updateBufAndCursor((b, c) => [b.slice(0, c) + text + b.slice(c), c + text.length]);
    desiredColRef.current = null;
  };

  // Bracketed-paste channel: the controller buffers chunks across keystrokes and delivers the
  // whole payload here once the closing marker arrives (markers stripped, newlines normalized).
  const paste = usePaste(insertAtCursor);

  useCaretBlink(setCaretOn);

  const { cursorLine, cursorCol, viewport, windowStart, visible, hasAbove, hasBelow } = useTextAreaViewport(
    buf,
    cursor,
    term.rows,
    firstVisible,
    setFirstVisible
  );

  useTextAreaKeyHandler(
    {
      bufRef,
      cursorRef,
      desiredColRef,
      viewport,
      updateCursor,
      updateBufAndCursor,
      insertAtCursor,
      onSubmit,
      onCancel,
    },
    paste.consume
  );

  return (
    <TextAreaFrame
      message={message}
      escLabel={escLabel}
      hasAbove={hasAbove}
      hasBelow={hasBelow}
      visible={visible}
      windowStart={windowStart}
      cursorLine={cursorLine}
      cursorCol={cursorCol}
      caretOn={caretOn}
    />
  );
};
