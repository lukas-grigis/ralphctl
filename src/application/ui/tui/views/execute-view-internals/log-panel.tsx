/** Chain log panel — the bottom "Recent log" tail surfaced to the operator. */

import React from 'react';
import { Box } from 'ink';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { RecentEventsTail } from '@src/application/ui/tui/components/recent-events-tail.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { LogEvent } from '@src/business/observability/events.ts';

/** Log buffer sizing: chain steps + provider debug lines run hot; 1000 covers a long run. */
export const LOG_TAIL_LIMIT = 1000;

interface LogPanelProps {
  readonly entries: readonly LogEvent[];
  readonly maxRows: number;
}

const LogPanelImpl = ({ entries, maxRows }: LogPanelProps): React.JSX.Element => (
  <Box marginTop={spacing.section}>
    <Card title="Recent log">
      <RecentEventsTail entries={entries} maxRows={maxRows} />
    </Card>
  </Box>
);

// Memoized: neither prop depends on the Execute view's 1 Hz clock — skips re-formatting the
// whole log tail on ticks where no new log line has actually arrived.
export const LogPanel = React.memo(LogPanelImpl);
