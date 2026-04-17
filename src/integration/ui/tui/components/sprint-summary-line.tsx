/**
 * SprintSummaryLine — single-line "what sprint am I in" indicator.
 *
 * Shown at the top of HomeView so users at the menu always know the current
 * sprint without navigating to Dashboard. Renders nothing when there is no
 * current sprint (the menu's empty-state copy carries that message).
 *
 * Format: `Sprint: <name> [status] · N tickets · M tasks · Provider: X`
 *
 * This is intentionally narrower than the Dashboard view's hero — Dashboard
 * owns the rich multi-line view; Home gets a single status line.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DashboardData } from '@src/integration/ui/tui/views/dashboard-data.ts';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';

interface Props {
  data: DashboardData | null;
}

function statusColor(status: string): string {
  switch (status) {
    case 'draft':
      return inkColors.muted;
    case 'active':
      return inkColors.success;
    case 'closed':
      return inkColors.info;
    default:
      return inkColors.muted;
  }
}

export function SprintSummaryLine({ data }: Props): React.JSX.Element | null {
  if (!data) return null;

  const { sprint, tasks, aiProvider } = data;
  const ticketCount = sprint.tickets.length;
  const taskCount = tasks.length;
  const providerLabel = aiProvider === 'claude' ? 'Claude' : aiProvider === 'copilot' ? 'Copilot' : null;

  return (
    <Box>
      <Text dimColor>Sprint: </Text>
      <Text color={inkColors.highlight} bold>
        {sprint.name}
      </Text>
      <Text> </Text>
      <Text color={statusColor(sprint.status)}>[{sprint.status}]</Text>
      <Text dimColor>
        {`  ${glyphs.inlineDot}  `}
        {String(ticketCount)} ticket{ticketCount !== 1 ? 's' : ''}
        {`  ${glyphs.inlineDot}  `}
        {String(taskCount)} task{taskCount !== 1 ? 's' : ''}
      </Text>
      {providerLabel ? (
        <Text dimColor>
          {`  ${glyphs.inlineDot}  `}
          Provider: {providerLabel}
        </Text>
      ) : null}
    </Box>
  );
}
