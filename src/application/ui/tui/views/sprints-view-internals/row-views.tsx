/**
 * Row presentation for the sprints list — one sprint per bordered card: name + status chip,
 * slug, and ticket count with pending/approved/blocked sub-counts. Pulled out of `sprints-view.tsx`
 * (which still owns data loading, cursor, and key handling) because the blocked-task sub-count
 * grew this into its own cohesive rendering unit, mirroring how `pick-sprint-internals/row-views.tsx`
 * splits row presentation out of its orchestrator.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { TaskHealthCounts } from '@src/application/ui/shared/state-snapshot.ts';

/**
 * Rendered height (rows) of one {@link SprintRow} card: border top, name, slug, ticket counts,
 * border bottom — plus the section margin below the card.
 */
export const ROW_HEIGHT = 5;

/** `· N pending` / `· N approved` tail on the ticket count. Renders nothing at zero. */
const TicketSubCount = ({
  count,
  label,
  color,
}: {
  readonly count: number;
  readonly label: string;
  readonly color: string;
}): React.JSX.Element | null =>
  count === 0 ? null : (
    <Text>
      <Text dimColor> {glyphs.bullet} </Text>
      <Text bold color={color}>
        {String(count)}
      </Text>
      <Text dimColor> {label}</Text>
    </Text>
  );

interface SprintRowProps {
  readonly sprint: Sprint;
  readonly focused: boolean;
  readonly health: TaskHealthCounts;
}

/** One sprint card: name + status chip, slug, ticket count with pending/approved/blocked sub-counts. */
export const SprintRow = ({ sprint, focused, health }: SprintRowProps): React.JSX.Element => {
  const countBy = (status: string): number => sprint.tickets.filter((t) => t.status === status).length;
  return (
    <Box flexDirection="column" marginBottom={spacing.section}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={focused ? inkColors.primary : inkColors.rule}
        borderDimColor={!focused}
        paddingX={spacing.cardPadX}
      >
        <Box justifyContent="space-between">
          <Text bold {...(focused ? { color: inkColors.primary } : {})}>
            {sprint.name}
          </Text>
          <StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />
        </Box>
        <Text dimColor>{sprint.slug}</Text>
        <Text>
          <Text bold>{String(sprint.tickets.length)}</Text>
          <Text dimColor> tickets</Text>
          <TicketSubCount count={countBy('pending')} label="pending" color={inkColors.warning} />
          <TicketSubCount count={countBy('approved')} label="approved" color={inkColors.success} />
          <TicketSubCount count={health.blockedTaskCount} label="blocked" color={inkColors.error} />
        </Text>
      </Box>
    </Box>
  );
};
