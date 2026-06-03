/**
 * Windowed-list primitive — the single mechanism for long, scrollable, homogeneous item lists
 * in the TUI. Unifies the three previously-divergent approaches (`pick-sprint-internals/window.ts`
 * + `row-views.tsx`, `card-list.tsx`, `list-view.tsx`) into one pure window calculator, one hook,
 * and a pair of thin render wrappers.
 *
 *   - {@link computeListWindow} — pure cursor-centred slice math (no header / create-row special
 *     cases — mirror of `pick-sprint-internals/window.ts` for a flat item list).
 *   - {@link useListWindow} — owns cursor + keyboard. CRITICAL: the cursor is stored as an *id*
 *     string, not an index, so a reorder or eviction of items keeps focus on the same logical
 *     item (or snaps to the nearest survivor) rather than silently jumping to whatever now sits
 *     at the old index.
 *   - {@link WindowedList} + {@link OverflowRow} — render wrappers for views that don't need
 *     bespoke layout. Overflow cues use the `glyphs.moreAbove` / `glyphs.moreBelow` tokens.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';

/** Visible slice of a list. `start` inclusive, `end` exclusive. */
export interface ListWindow {
  readonly start: number;
  readonly end: number;
  readonly hasAbove: boolean;
  readonly hasBelow: boolean;
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/**
 * Compute a cursor-centred slice of a flat, homogeneous item list. Keeps `focusedIndex` inside
 * `[start, end)` with roughly one window-half of context on either side, clamped to list bounds.
 * Returns the full list (no overflow flags) when everything fits within `visibleRows`.
 *
 * Defensive on bad inputs: `visibleRows <= 0` and an empty list both yield an empty window so a
 * caller can render nothing without a branch. Pure — safe to memoise on its three inputs.
 */
export const computeListWindow = (totalItems: number, focusedIndex: number, visibleRows: number): ListWindow => {
  if (totalItems <= 0 || visibleRows <= 0) return { start: 0, end: 0, hasAbove: false, hasBelow: false };
  if (totalItems <= visibleRows) return { start: 0, end: totalItems, hasAbove: false, hasBelow: false };

  const focus = clamp(focusedIndex, 0, totalItems - 1);
  const half = Math.floor(visibleRows / 2);
  let start = Math.max(0, focus - half);
  let end = start + visibleRows;
  if (end > totalItems) {
    end = totalItems;
    start = Math.max(0, end - visibleRows);
  }
  return { start, end, hasAbove: start > 0, hasBelow: end < totalItems };
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

/**
 * Hook that owns cursor + keyboard for a windowed list.
 *
 * The cursor is an *id*, not an index: every render resolves the focused index by locating the
 * stored id in the current `items`. When the id is gone (item evicted, or reordered out of the
 * list), we snap to the nearest survivor by the *prior* index — clamped — so focus stays on
 * something stable instead of teleporting. A reorder that keeps the id present keeps focus on the
 * same logical item even though its index changed.
 *
 * Keys (active gated by `active`, default true): ↑/`k` up, ↓/`j` down (arrows primary, vim
 * aliases), PageUp/PageDown by `visibleRows`, Home/`g` first, End/`G` last, Enter/Return submits.
 * Movement clamps at both bounds and rewrites the cursor id to the landing item's id.
 */
export function useListWindow<T>({
  items,
  getId,
  visibleRows,
  active = true,
  onSubmit,
  initialCursorId,
}: UseListWindowOptions<T>): UseListWindowResult<T> {
  const [cursorId, setCursorId] = useState<string>(initialCursorId ?? '');

  // The prior resolved index — the snap anchor for an eviction. Kept in a ref (not state) so
  // updating it never schedules a render; it's read only inside the render-pure resolution below
  // and the keypress handler.
  const lastIndexRef = useRef<number>(0);

  // Resolve the effective focus for THIS render, purely. When the stored id is present, that's
  // the focus. When it's absent (item evicted, or reordered out), snap to the nearest survivor by
  // the prior index, clamped into range. The returned values use this resolution directly, so the
  // current render is already correct — no flash, no extra round-trip through an effect.
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

  // Persist the snap: keep the ref anchor and the cursor-id state in sync with the resolved focus
  // so the next interaction starts from a stable, correct position. Runs after render; the values
  // this hook returns already reflect `focusedIndex`, so this only matters for subsequent input.
  useEffect(() => {
    if (focusedIndex >= 0) lastIndexRef.current = focusedIndex;
    if (effectiveCursorId !== cursorId) setCursorId(effectiveCursorId);
  }, [focusedIndex, effectiveCursorId, cursorId]);

  const moveTo = (next: number): void => {
    const target = clamp(next, 0, items.length - 1);
    const item = items[target];
    if (item !== undefined) {
      lastIndexRef.current = target;
      setCursorId(getId(item));
    }
  };

  useInput(
    (input, key) => {
      if (!active || items.length === 0) return;
      const at = focusedIndex < 0 ? 0 : focusedIndex;
      if (key.upArrow || input === 'k') moveTo(at - 1);
      else if (key.downArrow || input === 'j') moveTo(at + 1);
      else if (key.pageUp) moveTo(at - visibleRows);
      else if (key.pageDown) moveTo(at + visibleRows);
      else if (key.home || input === 'g') moveTo(0);
      else if (key.end || input === 'G') moveTo(items.length - 1);
      else if (key.return) {
        const item = items[at];
        if (item !== undefined) onSubmit?.(item);
      }
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
}

/**
 * Dim "N more" overflow cue headed by the `moreAbove` / `moreBelow` glyph token. Renders nothing
 * when `count <= 0` so callers can mount it unconditionally.
 */
export const OverflowRow = ({ direction, count }: OverflowRowProps): React.JSX.Element | null => {
  if (count <= 0) return null;
  const glyph = direction === 'above' ? glyphs.moreAbove : glyphs.moreBelow;
  return (
    <Box paddingX={spacing.indent}>
      <Text dimColor>
        {glyph} {String(count)} more
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
 * Thin render wrapper for views that don't need bespoke layout: builds the window via
 * {@link useListWindow}, renders an {@link OverflowRow} above, the sliced visible items, and an
 * {@link OverflowRow} below. Long lists obey the slice-before-map mandate by construction.
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
      <OverflowRow direction="above" count={window.start} />
      {visibleItems.map((item, localIdx) => {
        const absoluteIndex = window.start + localIdx;
        return (
          <Box key={getId(item)} flexDirection="column">
            {renderItem(item, absoluteIndex === focusedIndex)}
          </Box>
        );
      })}
      <OverflowRow direction="below" count={items.length - window.end} />
    </Box>
  );
}
