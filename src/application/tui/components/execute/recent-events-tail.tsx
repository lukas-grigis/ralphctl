/**
 * RecentEventsTail — rolling log-tail panel for the execute view.
 *
 * Renders the most recent log events scoped to a session.  Receives
 * pre-filtered events via props (the filtering is done in execute-view
 * via `useLoggerEvents({ sessionId })`).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { StatusChip } from '@src/application/tui/components/status-chip.tsx';
import type { LogEvent } from '@src/integration/logging/log-event-bus.ts';

/** How many events to show in the tail (last N). */
const VISIBLE_COUNT = 10;

interface RecentEventsTailProps {
  /** Pre-filtered event buffer (from useLoggerEvents). */
  readonly events: readonly LogEvent[];
}

function chipKindForLevel(level: string): 'error' | 'warning' | 'success' | 'info' | 'muted' {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warning';
  if (level === 'success') return 'success';
  if (level === 'info') return 'info';
  return 'muted';
}

export function RecentEventsTail({ events }: RecentEventsTailProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={spacing.section}>
      <Text dimColor bold>
        {glyphs.activityArrow} Recent events
      </Text>
      {events.length === 0 ? (
        <Box paddingLeft={spacing.indent}>
          <Text color={inkColors.muted} dimColor>
            No events yet — log lines from the chain will appear here.
          </Text>
        </Box>
      ) : (
        events.slice(-VISIBLE_COUNT).map((event, i) => (
          <Box key={i}>
            <Text color={inkColors.muted} dimColor>
              {String(event.timestamp).slice(11, 19)}{' '}
            </Text>
            <StatusChip label={event.level} kind={chipKindForLevel(event.level)} />
            <Text>{` ${event.message}`}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
