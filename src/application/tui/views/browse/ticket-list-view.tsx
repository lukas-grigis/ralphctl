/**
 * TicketListView — browse tickets for the current sprint.
 *
 * Loads the currentSprint from config, then shows all tickets. Scoped to
 * the current sprint. Press Enter to open the ticket show view (shows detail
 * inline). Empty state guides user to add a ticket.
 *
 * Keyboard: ↑/↓ navigate · Enter expand/collapse inline detail · Esc back
 */

import React, { useState } from 'react';
import { Box, useInput } from 'ink';
import { inkColors, spacing } from '../../../../integration/ui/theme/tokens.ts';
import { ViewShell } from '../../components/view-shell.tsx';
import { ListView, type ListColumn } from '../../components/list-view.tsx';
import { ResultCard } from '../../components/result-card.tsx';
import { Spinner } from '../../components/spinner.tsx';
import { useAsyncLoad } from '../../components/use-async-load.ts';
import { resolveCurrentSprintId } from '../../components/resolve-current-sprint.ts';
import { useViewHints } from '../view-hints-context.tsx';
import { useRouterOptional } from '../router-context.ts';
import { getSharedDeps } from '../../../bootstrap/get-shared-deps.ts';
import { ShowSprintUseCase } from '../../../../business/usecases/sprint/show-sprint.ts';
import { getKeyFor } from '../../keyboard-map.ts';
import type { Ticket } from '../../../../domain/entities/ticket.ts';

const LIST_HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'expand/collapse' },
  { key: getKeyFor('list.add'), action: 'add' },
  { key: getKeyFor('list.edit'), action: 'edit' },
  { key: getKeyFor('list.remove'), action: 'remove' },
] as const;

const COLUMNS: readonly ListColumn<Ticket>[] = [
  {
    header: 'REQ',
    cell: (t) => (t.requirementStatus === 'approved' ? 'approved' : 'pending'),
    width: 8,
    color: (t) => (t.requirementStatus === 'approved' ? inkColors.success : inkColors.warning),
  },
  {
    header: 'PROJECT',
    cell: (t) => String(t.projectName),
    width: 14,
  },
  {
    header: 'TITLE',
    cell: (t) => t.title,
    flex: true,
  },
];

interface TicketDetailProps {
  readonly ticket: Ticket;
}

function TicketDetail({ ticket }: TicketDetailProps): React.JSX.Element {
  const fields: [string, string][] = [
    ['ID', String(ticket.id)],
    ['Project', String(ticket.projectName)],
    ['Status', ticket.requirementStatus.toUpperCase()],
    ...(ticket.description !== undefined ? [['Desc', ticket.description] as [string, string]] : []),
    ...(ticket.link !== undefined ? [['Link', ticket.link] as [string, string]] : []),
  ];
  return (
    <Box marginTop={spacing.section} flexDirection="column">
      <ResultCard kind="info" title={ticket.title} fields={fields} />
    </Box>
  );
}

export function TicketListView(): React.JSX.Element {
  useViewHints(LIST_HINTS);
  const router = useRouterOptional();
  const { data: tickets, error } = useAsyncLoad<readonly Ticket[]>(async () => {
    const deps = await getSharedDeps();
    const idResult = await resolveCurrentSprintId(deps.configStore);
    if (!idResult.ok) throw new Error(idResult.error.message);
    const uc = new ShowSprintUseCase(deps.sprintRepo);
    const result = await uc.execute({ id: idResult.value });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.tickets;
  });
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [cursor, setCursor] = useState(0);

  const KEY_ADD = getKeyFor('list.add');
  const KEY_EDIT = getKeyFor('list.edit');
  const KEY_REMOVE = getKeyFor('list.remove');

  useInput((input) => {
    if (input === KEY_ADD) {
      router?.push({ id: 'ticket-add' });
      return;
    }
    if (input === KEY_EDIT) {
      const ticket = tickets?.[cursor];
      if (!ticket) return;
      router?.push({ id: 'ticket-edit', props: { ticketId: String(ticket.id) } });
      return;
    }
    if (input === KEY_REMOVE) {
      const ticket = tickets?.[cursor];
      if (!ticket) return;
      router?.push({ id: 'ticket-remove', props: { ticketId: String(ticket.id) } });
    }
  });

  return (
    <ViewShell title="TICKETS">
      <Box flexDirection="column">
        {tickets === null && error === null ? (
          <Spinner label="Loading tickets…" />
        ) : error !== null ? (
          <ResultCard kind="error" title="Failed to load tickets" lines={[error]} />
        ) : tickets !== null && tickets.length === 0 ? (
          <ResultCard
            kind="info"
            title="No tickets in current sprint."
            nextSteps={[{ action: 'Add a ticket', description: `press '${KEY_ADD}'` }]}
          />
        ) : (
          <>
            <ListView
              rows={tickets ?? []}
              columns={COLUMNS}
              onSelect={(t, idx) => {
                setCursor(idx);
                setSelected(t === selected ? null : t);
              }}
              emptyLabel="No tickets"
              initialCursor={cursor}
              onCursorChange={(_, idx) => {
                setCursor(idx);
              }}
            />
            {selected !== null ? <TicketDetail ticket={selected} /> : null}
          </>
        )}
      </Box>
    </ViewShell>
  );
}
