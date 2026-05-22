/**
 * Vertical action menu — keyboard-driven list of clickable items. Each item has a label, an
 * optional description, an optional `disabledReason`, and an `onSelect` callback. Disabled
 * items are dimmed and skipped during cursor movement (so the cursor never lands on a dead
 * row). Selecting an enabled item fires `onSelect`.
 *
 * Items can opt into a `section` label; when one item's section differs from the previous
 * item's, a small uppercase header is rendered above the first item of the new group. The
 * header is purely typographic — it never receives the cursor.
 *
 * Keyboard model:
 *   ↑/k        — previous enabled item
 *   ↓/j        — next enabled item
 *   g          — first enabled item
 *   G          — last enabled item
 *   ↵ / space  — select
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabledReason?: string;
  readonly onSelect: () => void;
  readonly hotkey?: string;
  /** Optional section label — small uppercased eyebrow above the group's first item. */
  readonly section?: string;
  /**
   * When true, the menu shows the hotkey hint but does NOT bind it locally — a higher-level
   * handler (typically `useGlobalKeys`) owns the binding. Without this, pressing the key would
   * fire both handlers and push the destination view onto the router stack twice.
   */
  readonly globalHotkey?: boolean;
}

export interface ActionMenuProps {
  readonly items: readonly MenuItem[];
  readonly initialIndex?: number;
  readonly active?: boolean;
}

const isEnabled = (item: MenuItem | undefined): boolean => item !== undefined && item.disabledReason === undefined;

const findFirstEnabled = (items: readonly MenuItem[], from: number, dir: 1 | -1): number | null => {
  let i = from;
  while (i >= 0 && i < items.length) {
    if (isEnabled(items[i])) return i;
    i += dir;
  }
  return null;
};

export const ActionMenu = ({ items, initialIndex = 0, active = true }: ActionMenuProps): React.JSX.Element => {
  const [cursor, setCursor] = useState<number>(() => {
    const first = findFirstEnabled(items, initialIndex, 1) ?? findFirstEnabled(items, items.length - 1, -1) ?? 0;
    return first;
  });

  // If the items list grows / shrinks, keep cursor on a valid row.
  useEffect(() => {
    if (cursor >= items.length) {
      setCursor(items.length === 0 ? 0 : items.length - 1);
    } else if (!isEnabled(items[cursor])) {
      const next = findFirstEnabled(items, cursor, 1) ?? findFirstEnabled(items, cursor, -1);
      if (next !== null) setCursor(next);
    }
  }, [items, cursor]);

  useInput(
    (input, key) => {
      if (!active) return;
      if (key.upArrow || input === 'k') {
        const next = findFirstEnabled(items, cursor - 1, -1);
        if (next !== null) setCursor(next);
        return;
      }
      if (key.downArrow || input === 'j') {
        const next = findFirstEnabled(items, cursor + 1, 1);
        if (next !== null) setCursor(next);
        return;
      }
      if (input === 'g') {
        const next = findFirstEnabled(items, 0, 1);
        if (next !== null) setCursor(next);
        return;
      }
      if (input === 'G') {
        const next = findFirstEnabled(items, items.length - 1, -1);
        if (next !== null) setCursor(next);
        return;
      }
      if (key.return || input === ' ') {
        const item = items[cursor];
        if (item && isEnabled(item)) item.onSelect();
        return;
      }
      // Hotkey support — first match wins. Items flagged `globalHotkey` are display-only here:
      // a higher-level handler owns the binding, so we'd fire navigation twice if we matched.
      if (input.length > 0) {
        const hit = items.findIndex((it) => it.hotkey === input && it.globalHotkey !== true && isEnabled(it));
        if (hit !== -1) {
          setCursor(hit);
          const item = items[hit];
          if (item) item.onSelect();
        }
      }
    },
    { isActive: active }
  );

  if (items.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>(no actions available)</Text>
      </Box>
    );
  }

  let lastSection: string | undefined;
  return (
    <Box flexDirection="column">
      {items.map((it, i) => {
        const focused = i === cursor;
        const enabled = isEnabled(it);
        const showHeader = it.section !== undefined && it.section !== lastSection;
        if (it.section !== undefined) lastSection = it.section;
        return (
          <Box key={it.id} flexDirection="column">
            {showHeader && (
              <Box paddingX={spacing.indent} marginTop={i === 0 ? 0 : 1}>
                <Text color={inkColors.muted} bold>
                  {(it.section ?? '').toUpperCase()}
                </Text>
              </Box>
            )}
            <Box flexDirection="column" paddingX={spacing.indent}>
              <Box>
                <Text color={focused ? inkColors.primary : inkColors.muted} bold={focused}>
                  {focused ? glyphs.actionCursor : ' '}{' '}
                </Text>
                <Text {...(enabled ? {} : { color: inkColors.muted })} bold={focused && enabled} dimColor={!enabled}>
                  {it.label}
                </Text>
                {it.hotkey !== undefined && (
                  <Text>
                    {'  '}
                    <Text color={enabled ? inkColors.highlight : inkColors.muted} bold={enabled}>
                      [{it.hotkey}]
                    </Text>
                  </Text>
                )}
              </Box>
              {focused && it.description !== undefined && it.description.length > 0 && (
                <Box paddingLeft={4}>
                  <Text dimColor>{it.description}</Text>
                </Box>
              )}
              {!enabled && it.disabledReason !== undefined && (
                <Box paddingLeft={4}>
                  {focused ? (
                    <Text color={inkColors.warning} wrap="truncate-end">
                      {glyphs.warningGlyph} {it.disabledReason}
                    </Text>
                  ) : (
                    <Text color={inkColors.muted} dimColor wrap="truncate-end">
                      {it.disabledReason}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};
