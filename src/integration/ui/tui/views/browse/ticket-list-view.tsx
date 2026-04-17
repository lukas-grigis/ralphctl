/**
 * TicketListView — scrollable table of tickets in the current sprint.
 */

import React, { useEffect, useState } from 'react';
import type { Ticket } from '@src/domain/models.ts';
import { listTickets } from '@src/integration/persistence/ticket.ts';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';
import { ListView, type ListColumn } from '@src/integration/ui/tui/components/list-view.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

type State = { kind: 'loading' } | { kind: 'empty' } | { kind: 'ready'; tickets: Ticket[] } | { kind: 'error'; message: string };

const COLUMNS: readonly ListColumn<Ticket>[] = [
  { header: 'ID', cell: (t) => t.id, width: 10 },
  { header: 'Title', cell: (t) => t.title, flex: true },
  { header: 'Project', cell: (t) => t.projectName, width: 16 },
  {
    header: 'Requirement',
    cell: (t) => t.requirementStatus,
    width: 11,
    color: (t) => (t.requirementStatus === 'approved' ? inkColors.success : inkColors.warning),
  },
];

const TITLE = 'Tickets' as const;
const HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
] as const;

export function TicketListView(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const tickets = await listTickets();
        if (ctl.cancelled) return;
        if (tickets.length === 0) setState({ kind: 'empty' });
        else setState({ kind: 'ready', tickets });
      } catch (err) {
        if (ctl.cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, []);

  return (
    <ViewShell title={TITLE}>
      {state.kind === 'loading' ? (
        <Spinner label="Loading tickets…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No tickets in this sprint" />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load tickets" lines={[state.message]} />
      ) : (
        <ListView<Ticket>
          rows={state.tickets}
          columns={COLUMNS}
          onSelect={(t) => {
            router.push({ id: 'ticket-show', props: { ticketId: t.id } });
          }}
        />
      )}
    </ViewShell>
  );
}
