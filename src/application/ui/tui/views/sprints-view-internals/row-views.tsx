/**
 * Row presentation for the sprints list — one sprint per `ListCard`: name + status chip, slug, and ticket count with
 * pending/approved/blocked sub-counts.
 */

import React from 'react';
import { Text } from 'ink';
import { sprintStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { ListCard } from '@src/application/ui/tui/components/list-card.tsx';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { TaskHealthCounts } from '@src/application/ui/shared/state-snapshot.ts';

/**
 * Rendered height (rows) of one {@link SprintRow} card: border top, name, slug, ticket counts, border bottom — plus
 * the section margin below the card (3 inner rows + 2 border + 1 margin).
 */
export const ROW_HEIGHT = 6;

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
    <ListCard
      focused={focused}
      title={sprint.name}
      rightSlot={<StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />}
    >
      <Text dimColor>{sprint.slug}</Text>
      <Text>
        <Text bold>{String(sprint.tickets.length)}</Text>
        <Text dimColor> {sprint.tickets.length === 1 ? 'ticket' : 'tickets'}</Text>
        <TicketSubCount count={countBy('pending')} label="pending" color={inkColors.warning} />
        <TicketSubCount count={countBy('approved')} label="approved" color={inkColors.success} />
        <TicketSubCount count={health.blockedTaskCount} label="blocked" color={inkColors.error} />
      </Text>
    </ListCard>
  );
};
