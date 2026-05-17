/**
 * CardList — a vertical list of bordered cards. Like ListView but each item gets a multi-line
 * mini-card instead of a single column-aligned row, so the eye can scan a richer summary.
 *
 * Cursor + keyboard handling mirrors ListView (↑/↓, j/k, g/G, pageUp/pageDown, Enter selects).
 * Caller supplies a `renderCard(item, focused)` to draw whatever content fits.
 *
 * Pagination is by *cards* (each card may span multiple terminal rows) rather than by lines,
 * to keep the math simple — long item sets paginate cleanly even if cards have variable
 * height inside the configured `visibleRows`.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface CardListProps<T> {
  readonly items: readonly T[];
  readonly renderCard: (item: T, focused: boolean) => React.ReactNode;
  readonly onSelect?: (item: T, index: number) => void;
  readonly onCursor?: (item: T, index: number) => void;
  readonly visibleRows?: number;
  readonly active?: boolean;
  readonly emptyHint?: string;
  readonly initialIndex?: number;
  /** Sub-line shown under each card. Useful for "press d to delete" hints scoped to the row. */
  readonly footer?: (item: T, focused: boolean) => React.ReactNode;
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

export function CardList<T>({
  items,
  renderCard,
  onSelect,
  onCursor,
  visibleRows = 4,
  active = true,
  emptyHint = '(empty)',
  initialIndex = 0,
  footer,
}: CardListProps<T>): React.JSX.Element {
  const [cursor, setCursor] = useState<number>(() => clamp(initialIndex, 0, Math.max(0, items.length - 1)));

  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items.length, cursor]);

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
      else if (key.return) {
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
      {items.slice(window.start, window.end).map((item, localIdx) => {
        const i = window.start + localIdx;
        const focused = i === cursor;
        return (
          <Box key={`card-${String(i)}`} flexDirection="column" marginBottom={1}>
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={focused ? inkColors.primary : inkColors.rule}
              borderDimColor={!focused}
              paddingX={spacing.cardPadX}
            >
              {renderCard(item, focused)}
            </Box>
            {footer !== undefined && (
              <Box paddingX={spacing.indent}>
                <Text dimColor>{footer(item, focused)}</Text>
              </Box>
            )}
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
