/** Modal help reference. Renders a card listing the bindings that apply to where the operator is. */

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { keySections } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { signalLabelColor } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';
import { useActiveHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { useDocumentScroll } from '@src/application/ui/tui/components/overlay-internals/use-document-scroll.ts';
import { DocumentScrollFooter } from '@src/application/ui/tui/components/overlay-internals/document-scroll-footer.tsx';

/**
 * Rows the overlay spends on its own chrome, so the card never outgrows the terminal: outer paddingY (top + bottom) +
 * card border (top + bottom) + header + body marginTop + footer marginTop + footer row.
 */
const CHROME_ROWS = spacing.section * 2 + 2 + 1 + spacing.section + spacing.section + 1;
/** Floor on the scrollable body so a tiny terminal still shows something. */
const MIN_BODY_ROWS = 4;

/** Key-column bounds: wide enough for the longest chord of the current list, never more than a third of the card. */
const MIN_KEY_COL = 12;
const MAX_KEY_COL = 34;

/** `HelpRow.kind` discriminant for a section header row. */
const SECTION_TITLE = 'section-title';
/** `HelpRow.kind` discriminant for the spacer row that precedes a non-first section title. */
const BLANK = 'blank';

interface HelpRow {
  readonly kind: 'section-title' | 'binding' | 'blank';
  readonly title?: string;
  readonly keys?: readonly string[];
  readonly label?: string;
  readonly description?: string | undefined;
  readonly color?: string | undefined;
}

/**
 * Renders one row of the flattened help list — a section spacer, a section title, a key-chord binding, or a plain
 * reference row (signal vocabulary etc. with no key chord).
 */
const HelpRowView = ({ row, keyCol }: { readonly row: HelpRow; readonly keyCol: number }): React.JSX.Element => {
  if (row.kind === BLANK) {
    return <Text> </Text>;
  }
  if (row.kind === SECTION_TITLE) {
    return (
      <Box>
        <Text bold>{row.title}</Text>
      </Box>
    );
  }
  const rowKeys = row.keys ?? [];
  if (rowKeys.length > 0) {
    return (
      <Box>
        <Box width={keyCol} flexShrink={0}>
          <Text color={inkColors.highlight} wrap="truncate-end">
            {rowKeys.join(' · ')}
          </Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">
            {row.label}
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box>
      <Box width={keyCol} flexShrink={0}>
        <Text
          wrap="truncate-end"
          color={row.color ?? (row.label !== undefined ? signalLabelColor(row.label) : undefined) ?? inkColors.info}
          bold
        >
          {row.label}
        </Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">
          {row.description ?? ''}
        </Text>
      </Box>
    </Box>
  );
};

/** Width of a row's key cell: its chords joined, or the bare label of a vocabulary row. */
const keyCellText = (row: HelpRow): string =>
  row.kind !== 'binding' ? '' : (row.keys ?? []).length > 0 ? (row.keys ?? []).join(' · ') : (row.label ?? '');

/** Pushes a section title, preceded by `spacing.section` blank rows unless it opens the list. */
const pushSectionTitle = (rows: HelpRow[], title: string): void => {
  if (rows.length > 0) {
    for (let i = 0; i < spacing.section; i++) rows.push({ kind: BLANK });
  }
  rows.push({ kind: SECTION_TITLE, title });
};

/** Flattens the local view hints + every static keymap section into one renderable row list. */
const buildHelpRows = (
  localHints: ReturnType<typeof useActiveHints>,
  routeId: string | undefined,
  showAll: boolean
): readonly HelpRow[] => {
  const rows: HelpRow[] = [];

  if (localHints.length > 0) {
    pushSectionTitle(rows, 'This view');
    for (const h of localHints) {
      rows.push({ kind: 'binding', keys: [h.keys], label: h.label });
    }
  }

  for (const section of keySections) {
    if (!showAll && section.onlyOn !== undefined && (routeId === undefined || !section.onlyOn.includes(routeId))) {
      continue;
    }
    pushSectionTitle(rows, section.title);
    for (const b of section.bindings) {
      rows.push({
        kind: 'binding',
        keys: b.keys,
        label: b.label,
        description: b.description,
        color: b.color,
      });
    }
  }

  return rows;
};

export interface HelpOverlayProps {
  /** Route the help is opened on — scopes the route-bound sections. Omitted → general sections only. */
  readonly routeId?: string;
}

export const HelpOverlay = ({ routeId }: HelpOverlayProps = {}): React.JSX.Element => {
  const localHints = useActiveHints();
  const term = useTerminalSize();
  const [showAll, setShowAll] = useState(false);

  // Build a flat array of renderable rows from all sections so we can window them.
  const allRows = useMemo(
    (): readonly HelpRow[] => buildHelpRows(localHints, routeId, showAll),
    [localHints, routeId, showAll]
  );

  const bodyRows = Math.max(MIN_BODY_ROWS, term.rows - CHROME_ROWS);
  const lineCount = allRows.length;
  // Resets to the top when content changes (e.g. view switches while the overlay is open).
  const { offset } = useDocumentScroll(lineCount, bodyRows);

  // esc and `?` are handled by the global key handler before reaching here.
  useInput((_input, key) => {
    if (key.tab) setShowAll((v) => !v);
  });

  const keyCol = Math.min(
    MAX_KEY_COL,
    Math.max(MIN_KEY_COL, ...allRows.map((r) => keyCellText(r).length)) + spacing.indent
  );
  const visibleRows = allRows.slice(offset, offset + bodyRows);

  return (
    <Box flexDirection="column" paddingX={spacing.indent} paddingY={spacing.section}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={inkColors.primary}
        paddingX={spacing.indent}
        paddingY={0}
      >
        <Box justifyContent="space-between">
          <Text color={inkColors.primary} bold>
            {glyphs.badge} Keyboard reference
          </Text>
          <Text dimColor>esc · ? close · Tab {showAll ? 'this view' : 'all keys'}</Text>
        </Box>
        <Box flexDirection="column" marginTop={spacing.section}>
          {visibleRows.map((row, idx) => (
            <HelpRowView key={`${row.kind}-${String(offset + idx)}`} row={row} keyCol={keyCol} />
          ))}
        </Box>
        <DocumentScrollFooter offset={offset} bodyRows={bodyRows} lineCount={lineCount} />
      </Box>
    </Box>
  );
};
