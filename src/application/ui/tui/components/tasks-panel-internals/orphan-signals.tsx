/**
 * Cross-task notes pin for the Tasks panel — the signals whose timestamp doesn't fall inside any
 * task window, rendered above the per-task cards so notes-about-the-run aren't lost.
 *
 * Structurally unrelated to a task card: it has no status, no sub-steps and no evaluation, just a
 * capped list of stream rows, which is why it lives beside `task-row.tsx` rather than inside it.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { focusKey } from '@src/application/ui/tui/components/tasks-panel-internals/focus-keys.ts';
import { StreamSignalRow } from '@src/application/ui/tui/components/tasks-panel-internals/signal-rows.tsx';

const OrphanSignalsImpl = ({
  signals,
  max,
  focusedKey,
  expandedKeys,
  sliceStart,
}: {
  readonly signals: readonly HarnessSignal[];
  readonly max: number;
  readonly focusedKey: string | undefined;
  readonly expandedKeys: ReadonlySet<string>;
  /** Absolute signal index where the rendered slice starts. */
  readonly sliceStart: number;
}): React.JSX.Element | null => {
  if (signals.length === 0) return null;
  const rows = signals.slice(-max);
  // Display-clip marker: when the orphan-signals list is longer than the render budget, surface
  // the count of elided rows so the operator knows earlier notes exist beyond the window.
  const orphansElided = signals.length - rows.length;
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Text dimColor bold>
        {glyphs.bullet} Cross-task notes
      </Text>
      <Box flexDirection="column" paddingLeft={spacing.indent}>
        {orphansElided > 0 && (
          <Text
            dimColor
          >{`${glyphs.clipEllipsis} ${String(orphansElided)} earlier note${orphansElided === 1 ? '' : 's'}`}</Text>
        )}
        {rows.map((s, i) => {
          const key = focusKey('orphan', sliceStart + i);
          return (
            <StreamSignalRow
              key={`orphan-${String(sliceStart + i)}`}
              signal={s}
              focused={focusedKey === key}
              expanded={expandedKeys.has(key)}
            />
          );
        })}
      </Box>
    </Box>
  );
};

/** Default shallow-compare memo — no `nowMs`-style ticking prop here, so a plain `React.memo`
 *  is enough to skip re-rendering the cross-task notes block when an unrelated task card change
 *  (focus, expansion, a new per-task signal) triggers `TasksPanel` to re-render. */
export const OrphanSignals = React.memo(OrphanSignalsImpl);
