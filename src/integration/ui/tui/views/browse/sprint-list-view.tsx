/**
 * SprintListView — scrollable table of every sprint. Enter drills into the
 * corresponding detail view.
 */

import React, { useEffect, useState } from 'react';
import type { Sprint } from '@src/domain/models.ts';
import { listSprints } from '@src/integration/persistence/sprint.ts';
import { inkColors } from '@src/integration/ui/theme/tokens.ts';
import { ListView, type ListColumn } from '@src/integration/ui/tui/components/list-view.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

type State = { kind: 'loading' } | { kind: 'empty' } | { kind: 'ready'; sprints: Sprint[] } | { kind: 'error'; message: string };

const COLUMNS: readonly ListColumn<Sprint>[] = [
  { header: 'ID', cell: (s) => s.id },
  { header: 'Name', cell: (s) => s.name, flex: true },
  {
    header: 'Status',
    cell: (s) => s.status,
    color: (s) => (s.status === 'active' ? inkColors.success : s.status === 'draft' ? inkColors.warning : inkColors.muted),
    width: 8,
  },
  { header: 'Tickets', cell: (s) => String(s.tickets.length), align: 'right', width: 7 },
];

const TITLE = 'Sprints' as const;
const HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
] as const;

export function SprintListView(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const sprints = await listSprints();
        if (ctl.cancelled) return;
        if (sprints.length === 0) setState({ kind: 'empty' });
        else setState({ kind: 'ready', sprints });
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
        <Spinner label="Loading sprints…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No sprints yet" />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load sprints" lines={[state.message]} />
      ) : (
        <ListView<Sprint>
          rows={state.sprints}
          columns={COLUMNS}
          onSelect={(s) => {
            router.push({ id: 'sprint-show', props: { sprintId: s.id } });
          }}
          emptyLabel="No sprints"
        />
      )}
    </ViewShell>
  );
}
