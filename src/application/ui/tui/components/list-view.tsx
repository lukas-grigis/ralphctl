/**
 * Generic list view with column-based rows. Caller supplies columns + items + a render-cell
 * callback. Cursor moves via arrow keys or vim j/k; pageUp/pageDown jump by viewport size; g/G
 * snap to top/bottom. The selected row is rendered bold + focus glyph; a separate `onSelect`
 * fires on Enter.
 *
 * Pagination: a windowed viewport (height = `visibleRows`) so long lists stay performant —
 * only visible rows are rendered, and the window slides as the cursor moves.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface ListColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly width?: number;
  readonly grow?: boolean;
  readonly render: (item: T, focused: boolean) => React.ReactNode;
}

export interface ListViewProps<T> {
  readonly items: readonly T[];
  readonly columns: ReadonlyArray<ListColumn<T>>;
  readonly onSelect?: (item: T, index: number) => void;
  /** Fires every time the focus row changes — lets the parent track "selected" for d/e hotkeys. */
  readonly onCursor?: (item: T, index: number) => void;
  readonly visibleRows?: number;
  readonly active?: boolean;
  readonly emptyHint?: string;
  readonly initialIndex?: number;
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export function ListView<T>({
  items,
  columns,
  onSelect,
  onCursor,
  visibleRows = 12,
  active = true,
  emptyHint = '(empty)',
  initialIndex = 0,
}: ListViewProps<T>): React.JSX.Element {
  const [cursor, setCursor] = useState<number>(() => clamp(initialIndex, 0, Math.max(0, items.length - 1)));

  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items.length, cursor]);

  // Notify the parent on every cursor move (including the initial mount), so siblings can
  // track "currently focused item" without duplicating cursor state.
  useEffect(() => {
    if (items.length === 0) return;
    const item = items[cursor];
    if (item !== undefined) onCursor?.(item, cursor);
  }, [cursor, items, onCursor]);

  useInput(
    (input, key) => {
      if (!active || items.length === 0) return;
      if (key.upArrow || input === 'k') setCursor((c) => clamp(c - 1, 0, items.length - 1));
      else if (key.downArrow || input === 'j') setCursor((c) => clamp(c + 1, 0, items.length - 1));
      else if (key.pageUp) setCursor((c) => clamp(c - visibleRows, 0, items.length - 1));
      else if (key.pageDown) setCursor((c) => clamp(c + visibleRows, 0, items.length - 1));
      else if (input === 'g') setCursor(0);
      else if (input === 'G') setCursor(items.length - 1);
      else if (key.return || input === ' ') {
        const item = items[cursor];
        if (item !== undefined) onSelect?.(item, cursor);
      }
    },
    { isActive: active }
  );

  const window = useMemo(() => {
    const half = Math.floor(visibleRows / 2);
    const start = clamp(cursor - half, 0, Math.max(0, items.length - visibleRows));
    const end = Math.min(items.length, start + visibleRows);
    return { start, end };
  }, [cursor, items.length, visibleRows]);

  if (items.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>{emptyHint}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={spacing.indent}>
        <Text dimColor bold>
          {'  '}
        </Text>
        {columns.map((col, idx) => (
          <Box key={col.key} {...colSizingProps(col)}>
            <Text dimColor bold>
              {col.header}
              {idx < columns.length - 1 ? '  ' : ''}
            </Text>
          </Box>
        ))}
      </Box>
      {items.slice(window.start, window.end).map((item, localIdx) => {
        const i = window.start + localIdx;
        const focused = i === cursor;
        return (
          <Box key={`row-${String(i)}`} paddingX={spacing.indent}>
            <Text color={focused ? inkColors.primary : inkColors.muted}>{focused ? glyphs.actionCursor : ' '} </Text>
            {columns.map((col, idx) => (
              <Box key={col.key} {...colSizingProps(col)}>
                <Text bold={focused}>{col.render(item, focused)}</Text>
                {idx < columns.length - 1 && <Text> </Text>}
              </Box>
            ))}
          </Box>
        );
      })}
      {items.length > visibleRows && (
        <Box paddingX={spacing.indent}>
          <Text dimColor>
            {String(cursor + 1)} of {String(items.length)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

const colSizingProps = <T,>(col: ListColumn<T>): { readonly width?: number; readonly flexGrow?: number } => {
  if (col.grow === true) return { flexGrow: 1 };
  if (col.width !== undefined) return { width: col.width };
  return { flexGrow: 1 };
};
