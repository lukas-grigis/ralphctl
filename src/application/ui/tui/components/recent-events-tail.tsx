/**
 * Recent log entries panel — short rolling tail of the latest log events, one per row. Time is
 * shown HH:MM:SS, the level chip is colour-coded, and the message is truncated at the visible
 * width.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { LogEvent } from '@src/business/observability/events.ts';
import { inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';

const LEVEL_COLOR: Readonly<Record<LogEvent['level'], string>> = {
  debug: inkColors.muted,
  info: inkColors.info,
  warn: inkColors.warning,
  error: inkColors.error,
};

export interface RecentEventsTailProps {
  readonly entries: readonly LogEvent[];
  readonly maxRows?: number;
}

export const RecentEventsTail = ({ entries, maxRows = 8 }: RecentEventsTailProps): React.JSX.Element => {
  const rows = entries.slice(-maxRows);
  if (rows.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>(no log entries yet)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {rows.map((entry, i) => (
        <Box key={`log-${String(i)}`} paddingX={spacing.indent}>
          <Text dimColor>{fmtIsoTime(String(entry.at))}</Text>
          <Text color={LEVEL_COLOR[entry.level]} bold>
            {'  '}
            {entry.level.toUpperCase().padEnd(5)}
          </Text>
          <Text> {entry.message}</Text>
        </Box>
      ))}
    </Box>
  );
};
