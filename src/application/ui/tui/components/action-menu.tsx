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
  /**
   * Optional factual cost/session hint rendered dimmed on a third line beneath the focused
   * row's description. Only the focused row shows it — unfocused rows remain compact.
   * Sourced from {@link FlowManifest.costHint} for flows that have one.
   */
  readonly costHint?: string;
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

/** Seed the cursor from `initialIndex` (index into the full items array). */
const findInitialCursorId = (
  items: readonly MenuItem[],
  initialIndex: number,
  enabledItems: readonly MenuItem[]
): string => {
  for (let i = initialIndex; i < items.length; i++) {
    const it = items[i];
    if (it !== undefined && isEnabled(it)) return it.id;
  }
  return enabledItems[0]?.id ?? '';
};

/** Hotkey match for the space-as-select / hotkey `useInput` handler (skips global hotkeys). */
const matchHotkey = (items: readonly MenuItem[], input: string): MenuItem | undefined =>
  items.find((it) => it.hotkey === input && it.globalHotkey !== true && isEnabled(it));

interface RenderRow {
  readonly item: MenuItem;
  readonly focused: boolean;
  readonly showHeader: boolean;
}

/**
 * An enabled item is visible when it falls inside the current window; a disabled item is
 * visible only when its section is also represented in the window (or the window is empty).
 */
const isRowVisible = (
  it: MenuItem,
  enabled: boolean,
  visibleEnabledIds: ReadonlySet<string>,
  windowedEnabled: readonly MenuItem[]
): boolean => {
  if (enabled) return visibleEnabledIds.has(it.id);
  if (windowedEnabled.length === 0) return true;
  return windowedEnabled.some((w) => w.section === it.section);
};

/**
 * Walk the full items array, skipping enabled items outside the window and disabled items not
 * adjacent to a visible section. Section headers render only when at least one of their members
 * will render.
 */
const buildRenderRows = (
  items: readonly MenuItem[],
  windowedEnabled: readonly MenuItem[],
  cursorId: string
): RenderRow[] => {
  const visibleEnabledIds = new Set(windowedEnabled.map((it) => it.id));
  const renderRows: RenderRow[] = [];
  let lastSection: string | undefined;
  let lastRenderedSection: string | undefined;

  for (const it of items) {
    const enabled = isEnabled(it);
    const visible = isRowVisible(it, enabled, visibleEnabledIds, windowedEnabled);

    if (!visible) {
      // Track section transitions even for skipped rows so the header logic stays correct.
      if (it.section !== undefined) lastSection = it.section;
      continue;
    }

    const sectionChanged = it.section !== undefined && it.section !== lastSection;
    if (it.section !== undefined) lastSection = it.section;

    const showHeader = sectionChanged && it.section !== lastRenderedSection;
    if (showHeader && it.section !== undefined) lastRenderedSection = it.section;

    renderRows.push({ item: it, focused: it.id === cursorId, showHeader });
  }

  return renderRows;
};

const SectionHeader = ({
  section,
  renderIdx,
}: {
  readonly section: string | undefined;
  readonly renderIdx: number;
}): React.JSX.Element => (
  <Box paddingX={spacing.indent} marginTop={renderIdx === 0 ? 0 : 1}>
    <Text color={inkColors.muted} bold>
      {(section ?? '').toUpperCase()}
    </Text>
  </Box>
);

const RowHotkeyHint = ({
  hotkey,
  enabled,
}: {
  readonly hotkey: string | undefined;
  readonly enabled: boolean;
}): React.JSX.Element | null => {
  if (hotkey === undefined) return null;
  return (
    <Text>
      {'  '}
      <Text color={enabled ? inkColors.highlight : inkColors.muted} bold={enabled}>
        [{hotkey}]
      </Text>
    </Text>
  );
};

const RowDescription = ({
  focused,
  description,
}: {
  readonly focused: boolean;
  readonly description: string | undefined;
}): React.JSX.Element | null => {
  if (!focused || description === undefined || description.length === 0) return null;
  return (
    <Box paddingX={spacing.indent}>
      <Text dimColor>{description}</Text>
    </Box>
  );
};

const RowCostHint = ({
  focused,
  costHint,
}: {
  readonly focused: boolean;
  readonly costHint: string | undefined;
}): React.JSX.Element | null => {
  if (!focused || costHint === undefined || costHint.length === 0) return null;
  return (
    <Box paddingX={spacing.indent}>
      <Text color={inkColors.muted} dimColor>
        {glyphs.bullet} {costHint}
      </Text>
    </Box>
  );
};

const RowDisabledReason = ({
  enabled,
  focused,
  disabledReason,
}: {
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly disabledReason: string | undefined;
}): React.JSX.Element | null => {
  if (enabled || disabledReason === undefined) return null;
  return (
    <Box paddingX={spacing.indent}>
      {focused ? (
        <Text color={inkColors.warning} wrap="truncate-end">
          {glyphs.warningGlyph} {disabledReason}
        </Text>
      ) : (
        <Text color={inkColors.muted} dimColor wrap="truncate-end">
          {disabledReason}
        </Text>
      )}
    </Box>
  );
};

interface ActionMenuRowProps {
  readonly item: MenuItem;
  readonly focused: boolean;
  readonly showHeader: boolean;
  readonly renderIdx: number;
}

const ActionMenuRow = ({ item: it, focused, showHeader, renderIdx }: ActionMenuRowProps): React.JSX.Element => {
  const enabled = isEnabled(it);
  return (
    <Box flexDirection="column">
      {showHeader && <SectionHeader section={it.section} renderIdx={renderIdx} />}
      <Box flexDirection="column" paddingX={spacing.indent}>
        <Box>
          <Text color={focused ? inkColors.primary : inkColors.muted} bold={focused}>
            {focused ? glyphs.actionCursor : ' '}{' '}
          </Text>
          <Text {...(enabled ? {} : { color: inkColors.muted })} bold={focused && enabled} dimColor={!enabled}>
            {it.label}
          </Text>
          <RowHotkeyHint hotkey={it.hotkey} enabled={enabled} />
        </Box>
        <RowDescription focused={focused} description={it.description} />
        <RowCostHint focused={focused} costHint={it.costHint} />
        <RowDisabledReason enabled={enabled} focused={focused} disabledReason={it.disabledReason} />
      </Box>
    </Box>
  );
};

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
  const initialCursorId = useMemo(
    () => findInitialCursorId(items, initialIndex, enabledItems),
    [items, initialIndex, enabledItems]
  );

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
        const hit = matchHotkey(items, input);
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

  const aboveCount = window.start;
  const belowCount = enabledItems.length - window.end;
  const renderRows = buildRenderRows(items, windowedEnabled, cursorId);

  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={aboveCount} />
      {renderRows.map(({ item: it, focused, showHeader }, renderIdx) => (
        <ActionMenuRow key={it.id} item={it} focused={focused} showHeader={showHeader} renderIdx={renderIdx} />
      ))}
      <OverflowRow direction="below" count={belowCount} />
    </Box>
  );
};
