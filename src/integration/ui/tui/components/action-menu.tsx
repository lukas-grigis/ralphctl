/**
 * ActionMenu — renders a `MenuItem[]` (from `src/tui/views/menu-builder.ts`) as
 * a single keyboard-navigated list.
 *
 * `@inkjs/ui`'s Select doesn't support non-selectable separators or disabled
 * options, and wrapping it alongside a parallel static render produced
 * duplicate React keys (the "Next Action" entry shares its `value` with the
 * same action inside its group). This component renders everything itself
 * using `useInput` so we can:
 *   - show separators inline as dim headings
 *   - skip disabled and separator items during up/down navigation
 *   - use a stable positional key (group/option index) instead of the value
 *     which is not unique across a main menu
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { isSeparator, type MenuItem } from '@src/integration/ui/tui/views/menu-builder.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';

interface Props {
  items: readonly MenuItem[];
  defaultValue?: string;
  onSelect: (value: string) => void;
  /** Called when the user hits Esc — typically to quit or navigate back. */
  onCancel?: () => void;
}

interface SelectableRow {
  kind: 'option';
  label: string;
  value: string;
  description?: string;
  disabled: boolean;
  disabledReason?: string;
}

interface SeparatorRow {
  kind: 'separator';
  text: string;
}

type Row = SelectableRow | SeparatorRow;

function toRows(items: readonly MenuItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (isSeparator(item)) {
      rows.push({ kind: 'separator', text: item.separator });
      continue;
    }
    const disabled = item.disabled !== false && item.disabled !== undefined;
    const disabledReason = typeof item.disabled === 'string' ? item.disabled : undefined;
    rows.push({
      kind: 'option',
      label: item.name,
      value: item.value,
      description: item.description,
      disabled,
      disabledReason,
    });
  }
  return rows;
}

function indexOfEnabled(rows: Row[], from: number, direction: 1 | -1): number {
  const n = rows.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step * direction + n) % n;
    const row = rows[i];
    if (row?.kind === 'option' && !row.disabled) return i;
  }
  return from;
}

function findInitialCursor(rows: Row[], defaultValue: string | undefined): number {
  if (defaultValue !== undefined) {
    const hit = rows.findIndex((r) => r.kind === 'option' && !r.disabled && r.value === defaultValue);
    if (hit >= 0) return hit;
  }
  const first = rows.findIndex((r) => r.kind === 'option' && !r.disabled);
  return first >= 0 ? first : 0;
}

export function ActionMenu({ items, defaultValue, onSelect, onCancel }: Props): React.JSX.Element {
  const rows = useMemo(() => toRows(items), [items]);
  const [cursor, setCursor] = useState(() => findInitialCursor(rows, defaultValue));

  // When items change (e.g. after a command runs and the menu rebuilds), re-anchor the cursor.
  useEffect(() => {
    setCursor(findInitialCursor(rows, defaultValue));
  }, [rows, defaultValue]);

  useInput((_input, key) => {
    if (key.escape && onCancel) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => indexOfEnabled(rows, c, -1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => indexOfEnabled(rows, c, 1));
      return;
    }
    if (key.return) {
      const row = rows[cursor];
      if (row?.kind === 'option' && !row.disabled) {
        onSelect(row.value);
      }
    }
  });

  const activeRow = rows[cursor];
  const activeDescription = activeRow?.kind === 'option' ? activeRow.description : undefined;

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        if (row.kind === 'separator') {
          return (
            <Text key={`sep-${String(i)}`} dimColor>
              {row.text}
            </Text>
          );
        }
        const selected = i === cursor;
        const pointer = selected ? `${glyphs.selectMarker} ` : '  ';
        const reason = row.disabledReason ? `  (${row.disabledReason})` : '';
        if (row.disabled) {
          return (
            <Text key={`opt-${String(i)}`} color={inkColors.muted} dimColor>
              {pointer}
              {row.label}
              {reason}
            </Text>
          );
        }
        return (
          <Text key={`opt-${String(i)}`} color={selected ? inkColors.highlight : undefined} bold={selected}>
            {pointer}
            {row.label}
          </Text>
        );
      })}
      <Box marginTop={spacing.section}>
        <Text dimColor>
          {activeDescription ? `${activeDescription}  ${glyphs.inlineDot}  ` : ''}
          ↑/↓ move {glyphs.inlineDot} Enter select {glyphs.inlineDot} Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
