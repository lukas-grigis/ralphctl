/**
 * SprintListView — browse all sprints.
 *
 * Lists sprints sorted by createdAt descending (newest first). Press Enter
 * to open the sprint show view. Empty state shows a next-step pointer.
 *
 * Keyboard: ↑/↓ navigate · Enter open · Esc back
 */

import React, { useState } from 'react';
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { Box, Text } from 'ink';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { ListView, type ListColumn } from '@src/application/tui/components/list-view.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { useAsyncLoad } from '@src/application/tui/components/use-async-load.ts';
import { chipKindForSprintStatus } from '@src/application/tui/components/status-chip.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouterOptional } from '@src/application/tui/views/router-context.ts';
import { getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { ListSprintsUseCase } from '@src/business/usecases/sprint/list-sprints.ts';
import { getKeyFor } from '@src/application/tui/keyboard-map.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';

const LIST_HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
  { key: getKeyFor('list.add'), action: 'add' },
  { key: getKeyFor('list.edit'), action: 'edit' },
  { key: getKeyFor('list.filter'), action: 'cycle filter' },
  { key: getKeyFor('list.setCurrent'), action: 'set current' },
] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const COLUMNS: readonly ListColumn<Sprint>[] = [
  {
    header: 'STATUS',
    cell: (s) => s.status.toUpperCase(),
    width: 8,
    color: (s) => {
      const kind = chipKindForSprintStatus(s.status);
      if (kind === 'success') return inkColors.success;
      if (kind === 'warning') return inkColors.warning;
      return inkColors.muted;
    },
  },
  {
    header: 'NAME',
    cell: (s) => s.name,
    flex: true,
  },
  {
    header: 'TICKETS',
    cell: (s) => String(s.tickets.length),
    width: 7,
    align: 'right',
  },
  {
    header: 'CREATED',
    cell: (s) => formatDate(s.createdAt),
    width: 12,
  },
];

type StatusFilter = 'all' | 'draft' | 'active' | 'closed';

const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'draft', 'active', 'closed'];

export function SprintListView(): React.JSX.Element {
  useViewHints(LIST_HINTS);
  const router = useRouterOptional();
  const { data: sprints, error } = useAsyncLoad<readonly Sprint[]>(async () => {
    const deps = await getSharedDeps();
    const uc = new ListSprintsUseCase(deps.sprintRepo);
    const result = await uc.execute();
    if (!result.ok) throw new Error(result.error.message);
    return [...result.value].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  });
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>('all');

  const visible = sprints === null ? null : filter === 'all' ? sprints : sprints.filter((s) => s.status === filter);

  const KEY_ADD = getKeyFor('list.add');
  const KEY_EDIT = getKeyFor('list.edit');
  const KEY_FILTER = getKeyFor('list.filter');
  const KEY_SET_CURRENT = getKeyFor('list.setCurrent');
  const KEY_REMOVE = getKeyFor('list.remove');

  useViewInput((input) => {
    if (input === KEY_ADD) {
      router?.push({ id: 'sprint-create' });
      return;
    }
    if (input === KEY_EDIT) {
      const row = visible?.[cursor];
      if (!row) return;
      router?.push({ id: 'sprint-edit', props: { sprintId: String(row.id) } });
      return;
    }
    if (input === KEY_FILTER) {
      setFilter((f) => {
        const idx = STATUS_FILTERS.indexOf(f);
        return STATUS_FILTERS[(idx + 1) % STATUS_FILTERS.length] ?? 'all';
      });
      return;
    }
    if (input === KEY_SET_CURRENT) {
      const row = visible?.[cursor];
      if (!row) return;
      void (async () => {
        try {
          const deps = await getSharedDeps();
          const config = await deps.configStore.load();
          if (!config.ok) return;
          await deps.configStore.save({ ...config.value, currentSprint: row.id });
        } catch {
          // non-fatal
        }
      })();
      return;
    }
    if (input === KEY_REMOVE) {
      const row = visible?.[cursor];
      if (!row) return;
      router?.push({ id: 'sprint-remove', props: { sprintId: String(row.id) } });
    }
  });

  function openSprint(sprint: Sprint, index: number): void {
    setCursor(index);
    router?.push({ id: 'sprint-show', props: { sprintId: String(sprint.id) } });
  }

  return (
    <ViewShell title="SPRINTS">
      <Box flexDirection="column">
        {filter !== 'all' ? (
          <Box>
            <Text dimColor>filter: {filter}</Text>
          </Box>
        ) : null}
        {sprints === null && error === null ? (
          <Spinner label="Loading sprints…" />
        ) : error !== null ? (
          <ResultCard kind="error" title="Failed to load sprints" lines={[error]} />
        ) : visible !== null && visible.length === 0 ? (
          <ResultCard
            kind="info"
            title={filter !== 'all' ? `No ${filter} sprints.` : 'No sprints yet.'}
            nextSteps={[{ action: 'Create one', description: `press '${KEY_ADD}'` }]}
          />
        ) : (
          <Box marginTop={spacing.section}>
            <ListView
              rows={visible ?? []}
              columns={COLUMNS}
              onSelect={openSprint}
              emptyLabel="No sprints"
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
