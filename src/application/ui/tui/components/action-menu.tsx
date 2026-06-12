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
 * Keyboard model (windowed-list contract, DESIGN-SYSTEM §6.4):
 *   ↑/k            — previous enabled item
 *   ↓/j            — next enabled item
 *   PgUp / Home    — first enabled item (g/G removed: `g` is the global progress-overlay toggle)
 *   PgDn / End     — last enabled item
 *   ↵              — select
 *   space          — select (hotkey handler)
 *
 * Navigation is implemented via `useListWindow` over the *enabled* item subset. Section headers
 * are render-only rows excluded from the cursorable set, mirroring the pick-sprint group approach.
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';

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
  /**
   * Number of enabled items visible at once. Defaults to all items (no windowing) when
   * undefined. Pass a value derived from `useBreakpoint().rows` to cap the list on short
   * terminals.
   */
  readonly visibleRows?: number;
}

const isEnabled = (item: MenuItem): boolean => item.disabledReason === undefined;

export const ActionMenu = ({
  items,
  initialIndex = 0,
  active = true,
  visibleRows,
}: ActionMenuProps): React.JSX.Element => {
  // Derive the cursorable subset. Only ENABLED items enter the windowed list; disabled and
  // section-header rows are render-only.
  const enabledItems = useMemo(() => items.filter(isEnabled), [items]);

  // Seed the cursor from `initialIndex` (index into the full items array).
  const initialCursorId = useMemo(() => {
    for (let i = initialIndex; i < items.length; i++) {
      const it = items[i];
      if (it !== undefined && isEnabled(it)) return it.id;
    }
    return enabledItems[0]?.id ?? '';
  }, [items, initialIndex, enabledItems]);

  const effectiveVisibleRows = visibleRows ?? enabledItems.length;

  const {
    cursorId,
    focusedItem,
    window,
    visibleItems: windowedEnabled,
  } = useListWindow<MenuItem>({
    items: enabledItems,
    getId: (it) => it.id,
    visibleRows: effectiveVisibleRows,
    active,
    initialCursorId,
    onSubmit: (it) => {
      it.onSelect();
    },
  });

  // Space-as-select and hotkey matching (navigation is owned by useListWindow).
  useInput(
    (input) => {
      if (!active) return;
      if (input === ' ') {
        focusedItem?.onSelect();
        return;
      }
      if (input.length > 0) {
        const hit = items.find((it) => it.hotkey === input && it.globalHotkey !== true && isEnabled(it));
        hit?.onSelect();
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

  // Build the set of enabled-item ids in the current window for O(1) lookup.
  const visibleEnabledIds = new Set(windowedEnabled.map((it) => it.id));
  const aboveCount = window.start;
  const belowCount = enabledItems.length - window.end;

  // Render pass: walk the full items array, skipping enabled items outside the window and
  // disabled items not adjacent to a visible section. Section headers render only when at
  // least one of their members will render.
  const renderRows: Array<{ item: MenuItem; focused: boolean; showHeader: boolean }> = [];
  let lastSection: string | undefined;
  let lastRenderedSection: string | undefined;

  for (const it of items) {
    const enabled = isEnabled(it);
    const inWindow = enabled && visibleEnabledIds.has(it.id);

    if (enabled && !inWindow) {
      // Track section transitions even for skipped rows so the header logic stays correct.
      if (it.section !== undefined) lastSection = it.section;
      continue;
    }

    if (!enabled) {
      // Render disabled items only when their section is also represented in the window.
      const sectionVisible = windowedEnabled.some((w) => w.section === it.section);
      if (!sectionVisible && windowedEnabled.length > 0) {
        if (it.section !== undefined) lastSection = it.section;
        continue;
      }
    }

    const sectionChanged = it.section !== undefined && it.section !== lastSection;
    if (it.section !== undefined) lastSection = it.section;

    const showHeader = sectionChanged && it.section !== lastRenderedSection;
    if (showHeader && it.section !== undefined) lastRenderedSection = it.section;

    renderRows.push({ item: it, focused: it.id === cursorId, showHeader });
  }

  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={aboveCount} />
      {renderRows.map(({ item: it, focused, showHeader }, renderIdx) => {
        const enabled = isEnabled(it);
        return (
          <Box key={it.id} flexDirection="column">
            {showHeader && (
              <Box paddingX={spacing.indent} marginTop={renderIdx === 0 ? 0 : 1}>
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
                <Box paddingX={spacing.indent}>
                  <Text dimColor>{it.description}</Text>
                </Box>
              )}
              {!enabled && it.disabledReason !== undefined && (
                <Box paddingX={spacing.indent}>
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
      <OverflowRow direction="below" count={belowCount} />
    </Box>
  );
};
