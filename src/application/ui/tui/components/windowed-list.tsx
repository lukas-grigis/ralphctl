/**
 * Windowed-list primitive — the single mechanism for long, scrollable, homogeneous item lists in the TUI.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';

/** How long after mount a move may wait for the rows to arrive. */
const TYPE_AHEAD_MS = 1500;

/** Visible slice of a list. `start` inclusive, `end` exclusive. */
export interface ListWindow {
  readonly start: number;
  readonly end: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/** Compute a cursor-centred slice of a flat, homogeneous item list. */
export const computeListWindow = (totalItems: number, focusedIndex: number, visibleRows: number): ListWindow => {
  if (totalItems <= 0) return { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 };
  if (visibleRows <= 0 || totalItems <= visibleRows) {
    return { start: 0, end: totalItems, hiddenAbove: 0, hiddenBelow: 0 };
  }

  const focus = clamp(focusedIndex, 0, totalItems - 1);
  const half = Math.floor(visibleRows / 2);
  let start = Math.max(0, focus - half);
  let end = start + visibleRows;
  if (end > totalItems) {
    end = totalItems;
    start = Math.max(0, end - visibleRows);
  }
  return { start, end, hiddenAbove: start, hiddenBelow: totalItems - end };
};

export interface UseListWindowOptions<T> {
  readonly items: readonly T[];
  readonly getId: (item: T) => string;
  readonly visibleRows: number;
  readonly active?: boolean | undefined;
  readonly onSubmit?: ((item: T) => void) | undefined;
  readonly initialCursorId?: string | undefined;
}

export interface UseListWindowResult<T> {
  readonly window: ListWindow;
  readonly visibleItems: readonly T[];
  readonly cursorId: string;
  readonly focusedIndex: number;
  readonly focusedItem: T | undefined;
}

/** Moves typed before the rows load (section switch + immediate ↓) wait for the data instead of vanishing. */
const useTypeAheadMoves = (
  itemCount: number,
  active: boolean,
  apply: (input: string, key: Key) => void
): { readonly hold: (input: string, key: Key) => void } => {
  const mountedAt = useRef(Date.now());
  const pending = useRef<Array<{ input: string; key: Key }>>([]);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (itemCount === 0 || pending.current.length === 0) return;
    const held = pending.current;
    pending.current = [];
    if (!active || Date.now() - mountedAt.current >= TYPE_AHEAD_MS) return;
    for (const m of held) applyRef.current(m.input, m.key);
  }, [itemCount, active]);

  return {
    hold: (input, key) => {
      const isMove = key.upArrow || key.downArrow || key.pageUp || key.pageDown || input === 'j' || input === 'k';
      if (isMove && Date.now() - mountedAt.current < TYPE_AHEAD_MS && pending.current.length < 8) {
        pending.current.push({ input, key });
      }
    },
  };
};

/** Hook that owns cursor + keyboard for a windowed list. */
export function useListWindow<T>({
  items,
  getId,
  visibleRows,
  active = true,
  onSubmit,
  initialCursorId,
}: UseListWindowOptions<T>): UseListWindowResult<T> {
  const [cursorId, setCursorId] = useState<string>(initialCursorId ?? '');

  // The prior resolved index — the snap anchor for an eviction.
  const lastIndexRef = useRef<number>(0);
  // Several keys in one stdin chunk run before any re-render, so each move must start from the last move, not the render.
  const liveCursorRef = useRef<string>(initialCursorId ?? '');

  // Resolve the effective focus for THIS render, purely. When the stored id is present, that's the focus.
  const focusedIndex = useMemo(() => {
    if (items.length === 0) return -1;
    const found = items.findIndex((item) => getId(item) === cursorId);
    if (found >= 0) return found;
    return clamp(lastIndexRef.current, 0, items.length - 1);
  }, [items, getId, cursorId]);

  const focusedItem = focusedIndex >= 0 ? items[focusedIndex] : undefined;
  // Effective id reflects the snap — the public cursor follows whatever is actually focused, even
  // before the reconciliation effect persists it back into state.
  const effectiveCursorId = focusedItem !== undefined ? getId(focusedItem) : cursorId;

  // Persist the snap: keep the ref anchor and the cursor-id state in sync with the resolved focus so the next
  // interaction starts from a stable, correct position.
  useEffect(() => {
    if (focusedIndex >= 0) lastIndexRef.current = focusedIndex;
    liveCursorRef.current = effectiveCursorId;
    if (effectiveCursorId !== cursorId) setCursorId(effectiveCursorId);
  }, [focusedIndex, effectiveCursorId, cursorId]);

  const moveTo = (next: number): void => {
    const target = clamp(next, 0, items.length - 1);
    const item = items[target];
    if (item !== undefined) {
      lastIndexRef.current = target;
      liveCursorRef.current = getId(item);
      setCursorId(getId(item));
    }
  };

  const liveIndex = (): number => {
    const found = items.findIndex((item) => getId(item) === liveCursorRef.current);
    if (found >= 0) return found;
    return focusedIndex < 0 ? 0 : focusedIndex;
  };

  const applyKey = (input: string, key: Key): void => {
    const at = liveIndex();
    if (key.upArrow || input === 'k') moveTo(at - 1);
    else if (key.downArrow || input === 'j') moveTo(at + 1);
    else if (key.pageUp) moveTo(at - visibleRows);
    else if (key.pageDown) moveTo(at + visibleRows);
    else if (key.home) moveTo(0);
    else if (key.end) moveTo(items.length - 1);
    else if (key.return) {
      const item = items[at];
      if (item !== undefined) onSubmit?.(item);
    }
  };

  const typeAhead = useTypeAheadMoves(items.length, active, applyKey);

  useInput(
    (input, key) => {
      if (!active) return;
      if (items.length === 0) typeAhead.hold(input, key);
      else applyKey(input, key);
    },
    { isActive: active }
  );

  const window = useMemo(
    () => computeListWindow(items.length, focusedIndex < 0 ? 0 : focusedIndex, visibleRows),
    [items.length, focusedIndex, visibleRows]
  );

  const visibleItems = useMemo(() => items.slice(window.start, window.end), [items, window.start, window.end]);

  return {
    window,
    visibleItems,
    cursorId: effectiveCursorId,
    focusedIndex,
    focusedItem,
  };
}

export interface OverflowRowProps {
  readonly direction: 'above' | 'below';
  readonly count: number;
  /** Trailing word(s) after the count — defaults to `more`. */
  readonly label?: string;
}

/**
 * Dim "N more" overflow cue headed by the `moreAbove` / `moreBelow` glyph token. Renders nothing when `count <= 0` so
 * callers can mount it unconditionally.
 */
export const OverflowRow = ({ direction, count, label = 'more' }: OverflowRowProps): React.JSX.Element | null => {
  if (count <= 0) return null;
  const glyph = direction === 'above' ? glyphs.moreAbove : glyphs.moreBelow;
  return (
    <Box paddingX={spacing.indent}>
      <Text dimColor>
        {glyph} {String(count)} {label}
      </Text>
    </Box>
  );
};

export interface WindowedListProps<T> {
  readonly items: readonly T[];
  readonly getId: (item: T) => string;
  readonly visibleRows: number;
  readonly renderItem: (item: T, isFocused: boolean) => React.ReactNode;
  readonly active?: boolean | undefined;
  readonly onSubmit?: ((item: T) => void) | undefined;
  readonly initialCursorId?: string | undefined;
  readonly emptyHint?: string | undefined;
}

/**
 * Thin render wrapper for views that don't need bespoke layout: builds the window via {@link useListWindow}, renders
 * the sliced visible items between two {@link OverflowRow}s.
 * @public
 */
export function WindowedList<T>({
  items,
  getId,
  visibleRows,
  renderItem,
  active = true,
  onSubmit,
  initialCursorId,
  emptyHint = '(empty)',
}: WindowedListProps<T>): React.JSX.Element {
  const { window, visibleItems, focusedIndex } = useListWindow({
    items,
    getId,
    visibleRows,
    active,
    onSubmit,
    initialCursorId,
  });

  if (items.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>{emptyHint}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={window.hiddenAbove} />
      {visibleItems.map((item, localIdx) => {
        const absoluteIndex = window.start + localIdx;
        return (
          <Box key={getId(item)} flexDirection="column">
            {renderItem(item, absoluteIndex === focusedIndex)}
          </Box>
        );
      })}
      <OverflowRow direction="below" count={window.hiddenBelow} />
    </Box>
  );
}
