/**
 * DashboardHeader — compact two-line sprint context block.
 *
 * Emits Ink elements so colours and layout are managed by props instead of
 * embedded ANSI strings. Pure function of `DashboardData`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DashboardData } from '@src/integration/ui/tui/views/dashboard-data.ts';
import { inkColors } from '@src/integration/ui/tui/theme/tokens.ts';

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

export function DashboardHeader({ data }: Props): React.JSX.Element | null {
  if (!data) return null;

  const { sprint, tasks, approvedCount, plannedTicketCount, aiProvider } = data;
  const ticketCount = sprint.tickets.length;
  const totalTasks = tasks.length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const inProgressCount = tasks.filter((t) => t.status === 'in_progress').length;
  const todoCount = tasks.filter((t) => t.status === 'todo').length;

  const providerLabel = aiProvider === 'claude' ? 'Claude' : aiProvider === 'copilot' ? 'Copilot' : null;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={inkColors.highlight} bold>
          {sprint.name}
        </Text>
        <Text>{'  '}</Text>
        <Text color={statusColor(sprint.status)}>[{sprint.status}]</Text>
        <Text dimColor>
          {'  |  '}
          {String(ticketCount)} ticket{ticketCount !== 1 ? 's' : ''}
          {'  |  '}
          {String(totalTasks)} task{totalTasks !== 1 ? 's' : ''}
        </Text>
        {providerLabel ? (
          <Text dimColor>
            {'  |  '}
            {providerLabel}
          </Text>
        ) : null}
      </Box>

      {(sprint.status === 'active' || sprint.status === 'closed') && totalTasks > 0 ? (
        <Box>
          <Text dimColor>
            {String(doneCount)} done · {String(inProgressCount)} active · {String(todoCount)} todo
          </Text>
        </Box>
      ) : null}

      {sprint.status === 'draft' && ticketCount > 0 ? (
        <Box>
          <Text color={approvedCount === ticketCount ? inkColors.success : inkColors.warning}>
            Refined: {String(approvedCount)}/{String(ticketCount)}
          </Text>
          <Text dimColor>{'  |  '}</Text>
          <Text color={plannedTicketCount === ticketCount ? inkColors.success : inkColors.muted}>
            Planned: {String(plannedTicketCount)}/{String(ticketCount)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
