/**
 * ProjectListView — browse all projects, alphabetically sorted.
 *
 * Press Enter to open the project show view.
 *
 * Keyboard: ↑/↓ navigate · Enter open · Esc back
 */

import React, { useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { spacing } from '../../../../integration/ui/theme/tokens.ts';
import { ViewShell } from '../../components/view-shell.tsx';
import { ListView, type ListColumn } from '../../components/list-view.tsx';
import { ResultCard } from '../../components/result-card.tsx';
import { Spinner } from '../../components/spinner.tsx';
import { useViewHints } from '../view-hints-context.tsx';
import { useRouterOptional } from '../router-context.ts';
import { getSharedDeps } from '../../../bootstrap/get-shared-deps.ts';
import { ListProjectsUseCase } from '../../../../business/usecases/project/list-projects.ts';
import { getKeyFor } from '../../keyboard-map.ts';
import type { Project } from '../../../../domain/entities/project.ts';

const LIST_HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
  { key: getKeyFor('list.add'), action: 'add' },
  { key: getKeyFor('list.remove'), action: 'remove' },
] as const;

function onboardedSuffix(p: Project): string {
  const total = p.repositories.length;
  if (total === 0) return '';
  const onboarded = p.repositories.filter((r) => r.onboardedAt !== null).length;
  if (total === 1) {
    return onboarded === 1 ? 'onboarded' : 'not onboarded';
  }
  return `${String(onboarded)}/${String(total)} onboarded`;
}

const COLUMNS: readonly ListColumn<Project>[] = [
  {
    header: 'NAME',
    cell: (p) => String(p.name),
    width: 20,
  },
  {
    header: 'DISPLAY NAME',
    cell: (p) => p.displayName,
    flex: true,
  },
  {
    header: 'REPOS',
    cell: (p) => String(p.repositories.length),
    width: 5,
    align: 'right',
  },
  {
    header: 'ONBOARDED',
    cell: onboardedSuffix,
    width: 18,
  },
];

export function ProjectListView(): React.JSX.Element {
  useViewHints(LIST_HINTS);
  const router = useRouterOptional();
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const cancel = { current: false };
    void (async () => {
      try {
        const deps = await getSharedDeps();
        const uc = new ListProjectsUseCase(deps.projectRepo);
        const result = await uc.execute();
        if (cancel.current) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        const sorted = [...result.value].sort((a, b) => String(a.name).localeCompare(String(b.name)));
        setProjects(sorted);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, []);

  const KEY_ADD = getKeyFor('list.add');
  const KEY_REMOVE = getKeyFor('list.remove');
  const KEY_EDIT = getKeyFor('list.edit');
  const KEY_ONBOARD = getKeyFor('list.onboard');

  useInput((input) => {
    if (input === KEY_ADD) {
      router?.push({ id: 'project-add' });
      return;
    }
    if (input === KEY_EDIT) {
      const project = projects?.[cursor];
      if (!project) return;
      router?.push({ id: 'project-edit', props: { projectName: String(project.name) } });
      return;
    }
    if (input === KEY_REMOVE) {
      const project = projects?.[cursor];
      if (!project) return;
      router?.push({ id: 'project-remove', props: { projectName: String(project.name) } });
      return;
    }
    if (input === KEY_ONBOARD) {
      // No onboard view in the current router yet — no-op; placeholder for future.
      return;
    }
  });

  function openProject(project: Project, index: number): void {
    setCursor(index);
    router?.push({ id: 'project-show', props: { projectName: String(project.name) } });
  }

  return (
    <ViewShell title="PROJECTS">
      <Box flexDirection="column">
        {projects === null && error === null ? (
          <Spinner label="Loading projects…" />
        ) : error !== null ? (
          <ResultCard kind="error" title="Failed to load projects" lines={[error]} />
        ) : projects !== null && projects.length === 0 ? (
          <ResultCard
            kind="info"
            title="No projects yet."
            nextSteps={[{ action: 'Add a project', description: `press '${KEY_ADD}'` }]}
          />
        ) : (
          <Box marginTop={spacing.section}>
            <ListView
              rows={projects ?? []}
              columns={COLUMNS}
              onSelect={openProject}
              emptyLabel="No projects"
              initialCursor={cursor}
              onCursorChange={(_, idx) => {
                setCursor(idx);
              }}
            />
          </Box>
        )}
      </Box>
    </ViewShell>
  );
}
