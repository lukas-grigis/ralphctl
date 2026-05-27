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
 */

import React from 'react';
import { RecentEventsTail } from '@src/application/ui/tui/components/recent-events-tail.tsx';
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
  <RecentEventsTail entries={entries} maxRows={maxRows} />
);
