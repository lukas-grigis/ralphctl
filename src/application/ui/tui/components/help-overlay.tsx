/**
 * Modal help reference. Renders a card listing every binding by area. The global key handler
 * intercepts `?` to open / close it; while open, every other global key is suspended (only
 * `esc` and `?` close).
 *
 * Per-view local hints (registered via {@link useViewHints}) are surfaced as the top section
 * so the overlay matches what the user can actually press right now. Static sections (global,
 * lists, execute) follow.
 *
 * Scroll model (active when content overflows the viewport):
 *   ↑ / ↓         → one line
 *   PgUp / PgDn   → one viewport
 *   lines X–Y of N footer cue when scrollable
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { keySections } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { SIGNAL_LABEL_COLOR } from '@src/application/ui/tui/components/tasks-panel.tsx';
import { useActiveHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';

/** Reserve rows for the overlay's own chrome (border + header + footer). */
const CHROME_ROWS = 6;
/** Floor on the scrollable body so a tiny terminal still shows something. */
const MIN_BODY_ROWS = 4;

/** `HelpRow.kind` discriminant for a section header row. */
const SECTION_TITLE = 'section-title';

interface HelpRow {
  readonly kind: 'section-title' | 'binding';
  readonly title?: string;
  readonly keys?: readonly string[];
  readonly label?: string;
  readonly description?: string | undefined;
  readonly color?: string | undefined;
}

export const HelpOverlay = (): React.JSX.Element => {
  const localHints = useActiveHints();
  const term = useTerminalSize();
  const [offset, setOffset] = useState(0);

  // Build a flat array of renderable rows from all sections so we can window them.
  const allRows = useMemo((): readonly HelpRow[] => {
    const rows: HelpRow[] = [];

    if (localHints.length > 0) {
      rows.push({ kind: SECTION_TITLE, title: 'This view' });
      for (const h of localHints) {
        rows.push({ kind: 'binding', keys: [h.keys], label: h.label });
      }
    }

    for (const section of keySections) {
      rows.push({ kind: SECTION_TITLE, title: section.title });
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
  }, [localHints]);

  const bodyRows = Math.max(MIN_BODY_ROWS, term.rows - CHROME_ROWS);
  const lineCount = allRows.length;
  const maxOffset = Math.max(0, lineCount - bodyRows);
  const clamp = (n: number): number => Math.max(0, Math.min(n, maxOffset));

  // Reset scroll when content changes (e.g. view switches while overlay is open).
  useEffect(() => {
    setOffset(0);
  }, [lineCount]);

  useInput((input, key) => {
    // Only scroll when content overflows.
    if (maxOffset === 0) return;
    if (key.upArrow) {
      setOffset((o) => clamp(o - 1));
      return;
    }
    if (key.downArrow) {
      setOffset((o) => clamp(o + 1));
      return;
    }
    if (key.pageUp) {
      setOffset((o) => clamp(o - bodyRows));
      return;
    }
    if (key.pageDown) {
      setOffset((o) => clamp(o + bodyRows));
    }
    // esc and `?` are handled by the global key handler before reaching here.
    void input;
  });

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
          <Text dimColor>esc · ? to close</Text>
        </Box>
        <Box flexDirection="column" marginTop={spacing.section}>
          {visibleRows.map((row, idx) => {
            if (row.kind === SECTION_TITLE) {
              return (
                <Box key={`title-${String(offset + idx)}`} marginTop={idx === 0 ? 0 : spacing.section}>
                  <Text bold>{row.title}</Text>
                </Box>
              );
            }
            // Binding row
            const rowKeys = row.keys ?? [];
            if (rowKeys.length > 0) {
              return (
                <Box key={`binding-${String(offset + idx)}`}>
                  <Box width={20}>
                    <Text color={inkColors.highlight}>{rowKeys.join(' · ')}</Text>
                  </Box>
                  <Text dimColor>{row.label}</Text>
                </Box>
              );
            }
            // Reference row (signal vocabulary etc.) — no key chord, label coloured.
            return (
              <Box key={`ref-${String(offset + idx)}`}>
                <Box width={20}>
                  <Text color={row.color ?? SIGNAL_LABEL_COLOR[row.label ?? ''] ?? inkColors.info} bold>
                    {row.label}
                  </Text>
                </Box>
                <Text dimColor>{row.description ?? ''}</Text>
              </Box>
            );
          })}
        </Box>
        {maxOffset > 0 && (
          <Box marginTop={spacing.section} justifyContent="space-between">
            <Text dimColor>
              lines {String(offset + 1)}–{String(Math.min(lineCount, offset + bodyRows))} of {String(lineCount)}
            </Text>
            <Text dimColor>
              {glyphs.bullet} ↑/↓ scroll {glyphs.bullet} PgUp/PgDn page
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
