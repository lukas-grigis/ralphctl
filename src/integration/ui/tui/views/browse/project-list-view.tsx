/**
 * ProjectListView — scrollable table of registered projects.
 */

import React, { useEffect, useState } from 'react';
import type { Project } from '@src/domain/models.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { ListView, type ListColumn } from '@src/integration/ui/tui/components/list-view.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

type State = { kind: 'loading' } | { kind: 'empty' } | { kind: 'ready'; projects: Project[] } | { kind: 'error'; message: string };

const COLUMNS: readonly ListColumn<Project>[] = [
  { header: 'Name', cell: (p) => p.name, width: 16 },
  { header: 'Display', cell: (p) => p.displayName, flex: true },
  { header: 'Repos', cell: (p) => String(p.repositories.length), align: 'right', width: 6 },
];

const TITLE = 'Projects' as const;
const HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
] as const;

export function ProjectListView(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const projects = await listProjects();
        if (ctl.cancelled) return;
        if (projects.length === 0) setState({ kind: 'empty' });
        else setState({ kind: 'ready', projects });
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
        <Spinner label="Loading projects…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No projects registered" />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load projects" lines={[state.message]} />
      ) : (
        <ListView<Project>
          rows={state.projects}
          columns={COLUMNS}
          onSelect={(p) => {
            router.push({ id: 'project-show', props: { projectName: p.name } });
          }}
        />
      )}
    </ViewShell>
  );
}
