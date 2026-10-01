/**
 * Vertical action menu — keyboard-driven list of clickable items. Each item has a label, an optional description, an
 * optional `disabledReason`, and an `onSelect` callback.
 */

import React, { useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { useScrollAnchor } from '@src/application/ui/tui/components/scroll-region.tsx';
import { listKeys } from '@src/application/ui/tui/runtime/keyboard-map.ts';

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
   * When true, the menu shows the hotkey hint but does NOT bind it locally — a higher-level handler (typically
   * `useGlobalKeys`) owns the binding.
   */
  readonly globalHotkey?: boolean;
  /**
   * Optional factual cost/session hint rendered dimmed on a third line beneath the focused row's description. Only
   * the focused row shows it — unfocused rows remain compact.
   */
  readonly costHint?: string;
  /** Glyph in front of the label; when any item has one, the rest reserve the same two columns. */
  readonly leading?: { readonly glyph: string; readonly tone: MenuTone };
  /** Right-aligned short fact. */
  readonly right?: string;
  /** Focused-only second line (generalises `costHint`). */
  readonly detail?: string;
  /** Inline dim text after the label; on a disabled row the reason takes its place (one line). */
  readonly note?: string;
}

export type MenuTone = 'error' | 'warning' | 'info' | 'success' | 'muted' | 'highlight';

export interface ActionMenuProps {
  readonly items: readonly MenuItem[];
  readonly initialIndex?: number;
  readonly active?: boolean;
  /** Number of enabled items visible at once. Defaults to all items (no windowing) when undefined. */
  readonly visibleRows?: number;
  /** Count shown after a section header (`NEEDS YOU  1`), keyed by the section label. */
  readonly sectionCounts?: Readonly<Record<string, number>>;
  /** Called with the focused item's id on mount and whenever the cursor moves. */
  readonly onFocusChange?: (id: string | undefined) => void;
  /** Blank rows above every section header but the first. Default 1. */
  readonly sectionGap?: number;
}

const NOTE_LABEL_MAX = 30;

const isEnabled = (item: MenuItem): boolean => item.disabledReason === undefined;

/**
 * Single-character nav aliases reserved by the windowed-list contract (DESIGN-SYSTEM §6.4) — derived from `listKeys`
 * so it can never drift from the actual `useListWindow` bindings.
 */
const RESERVED_NAV_KEYS: ReadonlySet<string> = new Set(
  [...listKeys.up.keys, ...listKeys.down.keys].filter((k) => /^[a-z]$/.test(k))
);

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

/**
 * Hotkey match for the space-as-select / hotkey `useInput` handler (skips global hotkeys and the reserved `j`/`k`
 * list-nav aliases — see {@link RESERVED_NAV_KEYS}).
 */
const matchHotkey = (items: readonly MenuItem[], input: string): MenuItem | undefined => {
  if (RESERVED_NAV_KEYS.has(input)) return undefined;
  return items.find((it) => it.hotkey === input && it.globalHotkey !== true && isEnabled(it));
};

interface RenderRow {
  readonly item: MenuItem;
  readonly focused: boolean;
  readonly showHeader: boolean;
}

/**
 * An enabled item is visible when it falls inside the current window; a disabled item is visible only when its
 * section is also represented in the window (or the window is empty).
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
 * Walk the full items array, skipping enabled items outside the window and disabled items not adjacent to a visible
 * section.
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
  count,
  gap,
}: {
  readonly section: string | undefined;
  readonly renderIdx: number;
  readonly count: number | undefined;
  readonly gap: number;
}): React.JSX.Element => (
  <Box paddingX={spacing.indent} marginTop={renderIdx === 0 ? 0 : gap}>
    <Text color={inkColors.muted} bold>
      {(section ?? '').toUpperCase()}
      {count !== undefined ? `  ${String(count)}` : ''}
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

const RowDetail = ({
  focused,
  detail,
}: {
  readonly focused: boolean;
  readonly detail: string | undefined;
}): React.JSX.Element | null => {
  if (!focused || detail === undefined || detail.length === 0) return null;
  return (
    <Box paddingLeft={spacing.indent * 2}>
      <Text dimColor wrap="truncate-end">
        {detail}
      </Text>
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
  readonly showCursor: boolean;
  readonly showHeader: boolean;
  readonly renderIdx: number;
  readonly sectionCount: number | undefined;
  readonly sectionGap: number;
  readonly reserveLeading: boolean;
  readonly labelWidth: number;
}

const LeadingSlot = ({
  leading,
  enabled,
  reserve,
}: {
  readonly leading: MenuItem['leading'];
  readonly enabled: boolean;
  readonly reserve: boolean;
}): React.JSX.Element | null => {
  if (leading !== undefined) {
    return <Text color={enabled ? inkColors[leading.tone] : inkColors.muted}>{leading.glyph} </Text>;
  }
  return reserve ? <Text>{'  '}</Text> : null;
};

/** The row's single line: cursor, leading glyph, label, inline note, hotkey, right-aligned fact. */
const RowLine = ({
  item: it,
  focused,
  showCursor,
  reserveLeading,
  labelWidth,
}: Pick<
  ActionMenuRowProps,
  'item' | 'focused' | 'showCursor' | 'reserveLeading' | 'labelWidth'
>): React.JSX.Element => {
  const enabled = isEnabled(it);
  const inline = !enabled && it.note !== undefined ? it.disabledReason : it.note;
  const cursorOn = focused && showCursor;
  return (
    <Box justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text color={cursorOn ? inkColors.primary : inkColors.muted} bold={focused}>
          {cursorOn ? glyphs.actionCursor : ' '}{' '}
        </Text>
        <LeadingSlot leading={it.leading} enabled={enabled} reserve={reserveLeading} />
        <Text {...(enabled ? {} : { color: inkColors.muted })} bold={focused && enabled} dimColor={!enabled}>
          {inline !== undefined ? it.label.padEnd(labelWidth) : it.label}
        </Text>
        {inline !== undefined && <Text dimColor>{`  ${inline}`}</Text>}
        <RowHotkeyHint hotkey={it.hotkey} enabled={enabled} />
      </Text>
      {it.right !== undefined && (
        <Box flexShrink={0} marginLeft={1}>
          <Text color={inkColors.muted} dimColor={!focused}>
            {it.right}
          </Text>
        </Box>
      )}
    </Box>
  );
};

const ActionMenuRow = ({
  item: it,
  focused,
  showHeader,
  renderIdx,
  sectionCount,
  sectionGap,
  ...lineProps
}: ActionMenuRowProps): React.JSX.Element => {
  // The focused row anchors the surrounding ScrollRegion so the cursor can never walk off-screen.
  const anchorRef = useScrollAnchor(focused);
  return (
    <Box ref={anchorRef} flexDirection="column">
      {showHeader && <SectionHeader section={it.section} renderIdx={renderIdx} count={sectionCount} gap={sectionGap} />}
      <Box flexDirection="column" paddingX={spacing.indent}>
        <RowLine item={it} focused={focused} {...lineProps} />
        <RowDescription focused={focused} description={it.description} />
        <RowDetail focused={focused} detail={it.detail} />
        <RowCostHint focused={focused} costHint={it.costHint} />
        {it.note === undefined && (
          <RowDisabledReason enabled={isEnabled(it)} focused={focused} disabledReason={it.disabledReason} />
        )}
      </Box>
    </Box>
  );
};

/** Space selects the focused row; a row's `hotkey` selects it directly. Navigation is `useListWindow`'s. */
const useMenuHotkeys = (items: readonly MenuItem[], focusedItem: MenuItem | undefined, active: boolean): void => {
  useInput(
    (input) => {
      if (!active) return;
      if (input === ' ') focusedItem?.onSelect();
      else if (input.length > 0) matchHotkey(items, input)?.onSelect();
    },
    { isActive: active }
  );
};

/** Column decisions shared by every row: the leading-glyph slot and the label column before notes. */
const menuLayout = (items: readonly MenuItem[]): { readonly reserveLeading: boolean; readonly labelWidth: number } => ({
  reserveLeading: items.some((it) => it.leading !== undefined),
  labelWidth: Math.min(
    NOTE_LABEL_MAX,
    items.reduce((w, it) => (it.note !== undefined ? Math.max(w, it.label.length) : w), 0)
  ),
});

export const ActionMenu = ({
  items,
  initialIndex = 0,
  active = true,
  visibleRows,
  sectionCounts,
  onFocusChange,
  sectionGap = 1,
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

  useEffect(() => {
    onFocusChange?.(focusedItem?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on cursor movement only
  }, [focusedItem?.id]);

  useMenuHotkeys(items, focusedItem, active);

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
  const { reserveLeading, labelWidth } = menuLayout(items);

  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={aboveCount} />
      {renderRows.map(({ item: it, focused, showHeader }, renderIdx) => (
        <ActionMenuRow
          key={it.id}
          item={it}
          focused={focused}
          showCursor={active}
          showHeader={showHeader}
          renderIdx={renderIdx}
          sectionCount={it.section !== undefined ? sectionCounts?.[it.section] : undefined}
          sectionGap={sectionGap}
          reserveLeading={reserveLeading}
          labelWidth={labelWidth}
        />
      ))}
      <OverflowRow direction="below" count={belowCount} />
    </Box>
  );
};
