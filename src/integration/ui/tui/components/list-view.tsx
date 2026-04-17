/**
 * ListView — scrollable keyboard-navigated table.
 *
 * Used by the Browse views (sprint list, ticket list, task list, project
 * list) to render a dense tabular view with arrow-key navigation and Enter
 * to drill into a detail view.
 *
 * Generic over the row type `T` so each consumer keeps strict typing at
 * the selection callback boundary.
 */

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';

export interface ListColumn<T> {
  readonly header: string;
  /** Cell value for a row. Keep it a plain string — no JSX to keep alignment predictable. */
  readonly cell: (row: T) => string;
  /** Fixed width; width==0 / undefined = auto (pad to max content + header). */
  readonly width?: number;
  /** `true` → take remaining space after other columns. At most one column should flex. */
  readonly flex?: boolean;
  /** Optional color function applied to the cell value. */
  readonly color?: (row: T) => string | undefined;
  /** Optional alignment. Default left. */
  readonly align?: 'left' | 'right';
}

export interface ListViewProps<T> {
  readonly rows: readonly T[];
  readonly columns: readonly ListColumn<T>[];
  readonly onSelect?: (row: T, index: number) => void;
  readonly emptyLabel?: string;
  /** Maximum rows rendered per "page". Window slides as the cursor moves. */
  readonly pageSize?: number;
  /** Initial cursor index. Default 0. */
  readonly initialCursor?: number;
  /** When false, input is ignored (used while a confirmation is pending). */
  readonly disabled?: boolean;
}

const DEFAULT_PAGE_SIZE = 12;

function computeWidths<T>(columns: readonly ListColumn<T>[], rows: readonly T[], totalWidth: number): number[] {
  const widths = columns.map((col) => {
    if (col.width !== undefined && !col.flex) return col.width;
    const dataMax = rows.reduce((w, r) => Math.max(w, col.cell(r).length), 0);
    return Math.max(col.header.length, dataMax);
  });
  // If a flex column exists, distribute remaining space.
  const flexIdx = columns.findIndex((c) => c.flex === true);
  if (flexIdx >= 0) {
    const fixed = widths.reduce((s, w, i) => (i === flexIdx ? s : s + w), 0);
    const gaps = (columns.length - 1) * 2;
    const remaining = Math.max(columns[flexIdx]?.header.length ?? 4, totalWidth - fixed - gaps);
    widths[flexIdx] = remaining;
  }
  return widths;
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (text.length >= width) return text.slice(0, width);
  const pad = ' '.repeat(width - text.length);
  return align === 'right' ? pad + text : text + pad;
}

export function ListView<T>({
  rows,
  columns,
  onSelect,
  emptyLabel = '(empty)',
  pageSize = DEFAULT_PAGE_SIZE,
  initialCursor = 0,
  disabled = false,
}: ListViewProps<T>): React.JSX.Element {
  const [cursor, setCursor] = useState(() => Math.max(0, Math.min(initialCursor, rows.length - 1)));

  const widths = useMemo(() => computeWidths(columns, rows, 72), [columns, rows]);

  useInput(
    (_input, key) => {
      if (rows.length === 0) return;
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(rows.length - 1, c + 1));
      else if (key.pageUp) setCursor((c) => Math.max(0, c - pageSize));
      else if (key.pageDown) setCursor((c) => Math.min(rows.length - 1, c + pageSize));
      else if (key.return && onSelect) {
        const row = rows[cursor];
        if (row !== undefined) onSelect(row, cursor);
      }
    },
    { isActive: !disabled }
  );

  if (rows.length === 0) {
    return (
      <Box>
        <Text dimColor>{emptyLabel}</Text>
      </Box>
    );
  }

  const windowStart = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), rows.length - pageSize));
  const windowEnd = Math.min(rows.length, windowStart + pageSize);
  const visible = rows.slice(windowStart, windowEnd);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={inkColors.muted} bold>
          {' '}
        </Text>
        {columns.map((col, i) => (
          <React.Fragment key={col.header}>
            <Text color={inkColors.muted} bold>
              {pad(col.header.toUpperCase(), widths[i] ?? col.header.length, col.align)}
            </Text>
            {i < columns.length - 1 ? <Text color={inkColors.muted}>{'  '}</Text> : null}
          </React.Fragment>
        ))}
      </Box>
      {visible.map((row, i) => {
        const absoluteIdx = windowStart + i;
        const selected = absoluteIdx === cursor;
        const indicatorColor = selected ? inkColors.highlight : undefined;
        return (
          <Box key={absoluteIdx}>
            <Text color={indicatorColor} bold={selected}>
              {selected ? glyphs.actionCursor : ' '}
            </Text>
            {columns.map((col, ci) => {
              const text = pad(col.cell(row), widths[ci] ?? col.cell(row).length, col.align);
              const cellColor = col.color?.(row) ?? (selected ? inkColors.highlight : undefined);
              return (
                <React.Fragment key={col.header}>
                  <Text color={cellColor} bold={selected && ci === 0}>
                    {text}
                  </Text>
                  {ci < columns.length - 1 ? <Text>{'  '}</Text> : null}
                </React.Fragment>
              );
            })}
          </Box>
        );
      })}
      {rows.length > pageSize ? (
        <Box marginTop={spacing.section}>
          <Text dimColor>
            {String(cursor + 1)} / {String(rows.length)} {glyphs.inlineDot} ↑/↓ PgUp/PgDn to scroll
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
