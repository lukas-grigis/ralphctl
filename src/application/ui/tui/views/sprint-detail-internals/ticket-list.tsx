/**
 * Tickets pane for the sprint-detail view.
 *
 * One bordered Jira-style card per ticket. Each card collapses to a description excerpt and
 * expands inline (full description + requirements + referenced tasks) when the orchestrator
 * passes `expanded=true` via the `openIds` set. Empty state and the local footer hints stay
 * here so the orchestrator only has to position the section.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ListCard } from '@src/application/ui/tui/components/list-card.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { StatusChip, taskStatusKind, ticketStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { computeListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Ticket } from '@src/domain/entity/ticket.ts';
import { Description, Section } from '@src/application/ui/tui/views/sprint-detail-internals/shared-prose.tsx';
import {
  type FocusItem,
  sectionWindowCards,
} from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';

interface TicketsSectionProps {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
  readonly focusList: readonly FocusItem[];
  readonly cursorIdx: number;
  readonly ticketsEditable: boolean;
  readonly feedback: string | undefined;
  readonly openIds: ReadonlySet<string>;
}

export const TicketsSection = ({
  sprint,
  tasks,
  focusList,
  cursorIdx,
  ticketsEditable,
  feedback,
  openIds,
}: TicketsSectionProps): React.JSX.Element => {
  const { rows } = useBreakpoint();
  // Tickets sit at the head of the shared focus list, so the shared cursor doubles as the local
  // ticket index. When it has moved past the tickets into the tasks pane, the index exceeds the
  // ticket count and `computeListWindow` clamps it to the last ticket — the window stays anchored
  // at the tail rather than scrolling away while focus lives below.
  const window = computeListWindow(sprint.tickets.length, cursorIdx, sectionWindowCards(rows));
  const visibleTickets = sprint.tickets.slice(window.start, window.end);
  return (
    <Box marginTop={spacing.section} flexDirection="column">
      <Text bold>{glyphs.badge} Tickets</Text>
      {sprint.tickets.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState
            title="No tickets yet"
            hint={
              ticketsEditable ? 'Press a to add the first one.' : 'Sprint is no longer in draft — tickets are frozen.'
            }
          />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <OverflowRow direction="above" count={window.start} />
          {visibleTickets.map((ticket, localIdx) => {
            const idx = window.start + localIdx;
            const focused = focusList[cursorIdx]?.kind === 'ticket' && focusList[cursorIdx]?.ticket.id === ticket.id;
            const expanded = openIds.has(String(ticket.id));
            const taskCount = tasks.filter((t) => t.ticketId === ticket.id).length;
            return (
              <TicketCard
                key={ticket.id}
                ticket={ticket}
                tasks={tasks}
                taskCount={taskCount}
                focused={focused}
                expanded={expanded}
                index={idx}
              />
            );
          })}
          <OverflowRow direction="below" count={sprint.tickets.length - window.end} />
        </Box>
      )}
      <Box paddingX={spacing.indent} marginTop={spacing.section}>
        <Text dimColor>
          {ticketsEditable
            ? `${glyphs.bullet} a add ${glyphs.bullet} ↵/o expand/collapse ${glyphs.bullet} d remove`
            : `${glyphs.bullet} tickets frozen (sprint not in draft) ${glyphs.bullet} ↵/o expand/collapse`}
        </Text>
      </Box>
      {feedback !== undefined && (
        <Box paddingX={spacing.indent} marginTop={1}>
          <Text color={feedback.startsWith('✗') ? inkColors.error : inkColors.primary}>{feedback}</Text>
        </Box>
      )}
    </Box>
  );
};

const TicketCard = ({
  ticket,
  tasks,
  taskCount,
  focused,
  expanded,
  index,
}: {
  readonly ticket: Ticket;
  readonly tasks: readonly Task[];
  readonly taskCount: number;
  readonly focused: boolean;
  readonly expanded: boolean;
  readonly index: number;
}): React.JSX.Element => (
  <ListCard
    focused={focused}
    rightSlot={<StatusChip label={ticket.status} kind={ticketStatusKind(ticket.status)} />}
    indexLabel={`#${String(index + 1)}`}
    title={ticket.title}
  >
    <Box>
      <Text dimColor>
        {glyphs.bullet} {String(taskCount)} task{taskCount === 1 ? '' : 's'}
      </Text>
      {ticket.link !== undefined && (
        <Text dimColor>
          {' '}
          {glyphs.bullet} {String(ticket.link)}
        </Text>
      )}
      {ticket.status === 'approved' && <Text dimColor> {glyphs.bullet} requirements ✓</Text>}
    </Box>
    {!expanded && ticket.description !== undefined && <Description text={ticket.description} maxLines={2} />}
    {expanded && <TicketDetailBody ticket={ticket} tasks={tasks} />}
  </ListCard>
);

const TicketDetailBody = ({
  ticket,
  tasks,
}: {
  readonly ticket: Ticket;
  readonly tasks: readonly Task[];
}): React.JSX.Element => {
  const referencedTasks = tasks.filter((t) => t.ticketId === ticket.id);
  return (
    <Box flexDirection="column">
      {ticket.description !== undefined && (
        <Section heading="Description">
          <Description text={ticket.description} maxLines={Number.POSITIVE_INFINITY} />
        </Section>
      )}
      {ticket.status === 'approved' && (
        <Section heading="Requirements">
          <Description text={ticket.requirements} maxLines={Number.POSITIVE_INFINITY} />
        </Section>
      )}
      {referencedTasks.length > 0 && (
        <Section heading="Referenced tasks">
          <Box flexDirection="column" paddingLeft={2}>
            {referencedTasks.map((t) => (
              <Box key={t.id}>
                <StatusChip label={t.status} kind={taskStatusKind(t.status)} />
                <Text bold> {t.name}</Text>
              </Box>
            ))}
          </Box>
        </Section>
      )}
    </Box>
  );
};
