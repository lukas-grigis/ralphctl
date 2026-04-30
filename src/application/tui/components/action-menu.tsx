/**
 * ActionMenu — keyboard-navigated list for Home submenus.
 *
 * Renders a `SubMenu` as a vertical list. Separator rows are purely visual
 * (non-selectable, non-navigable). Disabled items are shown with the disabled
 * reason in dim and cannot be selected.
 *
 * Keys:
 *   ↑/↓ (or k/j) — move cursor (separators + disabled rows are skipped)
 *   Enter         — fire `onSelect(item.action)` for the current item
 *   Esc           — call `onCancel()`
 *
 * The initial cursor lands on the first selectable item.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '../../../integration/ui/theme/tokens.ts';
import { isSeparator, type Choice, type MenuItem, type SubMenu } from '../views/menu-builder.ts';
import { actionKey, type MenuAction } from '../views/menu-action.ts';

interface Props {
  readonly items: SubMenu['items'];
  readonly onSelect: (action: MenuAction) => void;
  readonly onCancel: () => void;
  /** Optional initial selection by stable action key (see `actionKey`). */
  readonly initialActionKey?: string;
  readonly disabled?: boolean;
}

function isSelectable(item: MenuItem): item is Choice {
  if (isSeparator(item)) return false;
  if (item.disabled) return false;
  return true;
}

function findInitialCursor(items: readonly MenuItem[], initialActionKey?: string): number {
  if (initialActionKey !== undefined) {
    const idx = items.findIndex((item) => !isSeparator(item) && actionKey(item.action) === initialActionKey);
    const foundItem = idx >= 0 ? items[idx] : undefined;
    if (foundItem !== undefined && isSelectable(foundItem)) return idx;
  }
  // First selectable item
  const first = items.findIndex((item) => isSelectable(item));
  return first >= 0 ? first : 0;
}

function nextSelectableCursor(items: readonly MenuItem[], from: number, direction: 1 | -1): number {
  const n = items.length;
  let next = from + direction;
  while (next >= 0 && next < n) {
    const item = items[next];
    if (item !== undefined && isSelectable(item)) return next;
    next += direction;
  }
  return from;
}

export function ActionMenu({
  items,
  onSelect,
  onCancel,
  initialActionKey,
  disabled = false,
}: Props): React.JSX.Element {
  const [cursor, setCursor] = useState(() => findInitialCursor(items, initialActionKey));

  // Re-initialise cursor when items list changes (e.g. submenu drill-in).
  useEffect(() => {
    setCursor(findInitialCursor(items, initialActionKey));
  }, [items, initialActionKey]);

  const selectableCount = useMemo(() => items.filter(isSelectable).length, [items]);

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') {
        setCursor((c) => nextSelectableCursor(items, c, -1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => nextSelectableCursor(items, c, 1));
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        const item = items[cursor];
        if (item !== undefined && isSelectable(item)) {
          onSelect(item.action);
        }
      }
    },
    { isActive: !disabled && selectableCount > 0 }
  );

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        if (isSeparator(item)) {
          return (
            <Box key={`sep-${String(i)}`} marginTop={i === 0 ? 0 : spacing.section}>
              {item.separator !== '' ? (
                <Text color={inkColors.muted} dimColor bold>
                  {item.separator}
                </Text>
              ) : (
                <Text> </Text>
              )}
            </Box>
          );
        }

        const selected = !disabled && i === cursor;
        const isDisabled = Boolean(item.disabled);
        const disabledReason = typeof item.disabled === 'string' ? item.disabled : '';

        return (
          <Box key={`${item.name}-${actionKey(item.action)}`}>
            <Text color={selected ? inkColors.highlight : isDisabled ? inkColors.muted : undefined} bold={selected}>
              {selected ? `${glyphs.actionCursor} ` : '  '}
            </Text>
            <Text
              color={selected ? inkColors.highlight : isDisabled ? inkColors.muted : undefined}
              bold={selected}
              dimColor={isDisabled}
            >
              {item.name}
            </Text>
            {item.description !== undefined && !isDisabled ? (
              <Text dimColor>{`  ${glyphs.emDash} ${item.description}`}</Text>
            ) : null}
            {isDisabled && disabledReason !== '' ? (
              <Text color={inkColors.muted} dimColor>
                {`  (${disabledReason})`}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
