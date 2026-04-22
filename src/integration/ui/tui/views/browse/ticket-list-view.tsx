/**
 * TicketListView — scrollable table of tickets in a sprint.
 *
 * Accepts an optional `sprintId` prop. Falls back to the current sprint
 * when no id is supplied, so the view still works from the top-level
 * Browse menu as well as from the Sprint hub.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useInput } from 'ink';
import type { Project, Ticket } from '@src/domain/models.ts';
import { resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { listTickets } from '@src/integration/persistence/ticket.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';
import { ListView, type ListColumn } from '@src/integration/ui/tui/components/list-view.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

interface Props {
  readonly sprintId?: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; tickets: readonly Ticket[]; repoNamesById: ReadonlyMap<string, string> }
  | { kind: 'error'; message: string };

function requirementColor(status: Ticket['requirementStatus']): string {
  return status === 'approved' ? inkColors.success : inkColors.warning;
}

function buildColumns(repoNamesById: ReadonlyMap<string, string>): readonly ListColumn<Ticket>[] {
  return [
    {
      header: 'Requirement',
      cell: (t) => `[${t.requirementStatus.toUpperCase()}]`,
      width: 13,
      color: (t) => requirementColor(t.requirementStatus),
    },
    { header: 'Title', cell: (t) => t.title, flex: true },
    {
      header: 'Affected Repos',
      cell: (t) => {
        const ids = t.affectedRepoIds;
        if (!ids || ids.length === 0) return '—';
        return ids.map((id) => repoNamesById.get(id) ?? id).join(', ');
      },
      width: 24,
    },
  ];
}

const TITLE = 'Tickets' as const;
const HINTS_READY = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
  { key: 'a', action: 'add' },
  { key: 'e', action: 'edit' },
  { key: 'r', action: 'remove' },
] as const;
const HINTS_EMPTY = [{ key: 'a', action: 'add' }] as const;

export function TicketListView({ sprintId }: Props): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const id = await resolveSprintId(sprintId);
      const [tickets, projects] = await Promise.all([listTickets(id), listProjects()]);
      if (tickets.length === 0) {
        setState({ kind: 'empty' });
        return;
      }
      const repoNamesById = new Map<string, string>();
      for (const p of projects as readonly Project[]) {
        for (const r of p.repositories) repoNamesById.set(r.id, r.name);
      }
      setState({ kind: 'ready', tickets, repoNamesById });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [sprintId]);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      if (!ctl.cancelled) await load();
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [load]);

  useInput((input) => {
    if (state.kind === 'loading') return;
    if (input === 'a') {
      router.push({ id: 'ticket-add' });
      return;
    }
    if (state.kind !== 'ready') return;
    if (input === 'e') {
      router.push({ id: 'ticket-edit' });
      return;
    }
    if (input === 'r') {
      router.push({ id: 'ticket-remove' });
    }
  });

  useViewHints(state.kind === 'ready' ? HINTS_READY : HINTS_EMPTY);

  return (
    <ViewShell title={TITLE}>
      {state.kind === 'loading' ? (
        <Spinner label="Loading tickets…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No tickets in this sprint" lines={['Press `a` to add a ticket.']} />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load tickets" lines={[state.message]} />
      ) : (
        <ListView<Ticket>
          rows={state.tickets}
          columns={buildColumns(state.repoNamesById)}
          onSelect={(t) => {
            router.push({ id: 'ticket-show', props: { ticketId: t.id } });
          }}
        />
      )}
    </ViewShell>
  );
}
