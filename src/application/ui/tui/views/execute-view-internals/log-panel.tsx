/**
 * Chain log panel — the bottom "Recent log" tail surfaced to the operator. The view
 * subscribes to the log bus with a bounded buffer; the on-disk chain.log is the
 * authoritative trace, this is just the rolling tail.
 *
 * Trace ring-buffer note (kept here so future readers see the cap next to its consumer):
 * the runner caps `runner.trace` at `MAX_TRACE_ENTRIES = 5_000` (see
 * `src/application/chain/run/runner.ts`). That cap matters for code that *counts* trace
 * entries — `use-task-round-tracker.ts` carries the in-view monotonic high-water that
 * survives ring eviction. This panel is downstream of that and only renders whatever the
 * log bus has delivered.
 *
 * Visual treatment: the panel is wrapped in a bordered `Card` (tone "rule") so it reads
 * as a distinct region from the Steps / Tasks sections above it, matching the styling of
 * the BaselineHealthCard and TokenBudgetCard in the sidebar. The Card title ("Recent log")
 * replaces the outer `<Section>` heading that `body.tsx` previously supplied.
 *
 * Scroll: NOT added. Although the in-state buffer is already bounded at LOG_TAIL_LIMIT
 * (1 000 entries) and `RecentEventsTail` further slices to `maxRows`, adding ↑/↓ scroll
 * here requires a `useInput` handler that would race the global TUI hotkeys (Tab / Esc /
 * j / k are all consumed by the global key layer without `isActive` gating at the body
 * level). The visual separation is the primary ask; scroll is deferred until the global
 * input model exposes a focus-lane for this panel.
 */

import React from 'react';
import { Box } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { RecentEventsTail } from '@src/application/ui/tui/components/recent-events-tail.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { LogEvent } from '@src/business/observability/events.ts';

/**
 * Log buffer sizing: chain steps + provider debug lines run hot; 1000 covers a long run.
 * The full log lives on disk at `<sprintDir>/chain.log` so the view buffer is just the tail.
 */
export const LOG_TAIL_LIMIT = 1000;

interface LogPanelProps {
  readonly entries: readonly LogEvent[];
  readonly maxRows: number;
}

export const LogPanel = ({ entries, maxRows }: LogPanelProps): React.JSX.Element => (
  <Box marginTop={spacing.section}>
    <Card title="Recent log">
      <RecentEventsTail entries={entries} maxRows={maxRows} />
    </Card>
  </Box>
);
