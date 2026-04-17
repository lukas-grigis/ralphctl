/**
 * SprintShowView — the control centre for a single sprint.
 *
 * Header: FieldList with metadata (unchanged contract). Body: a list of
 * sub-sections the user navigates with ↑/↓ and opens with Enter. Available
 * sub-sections depend on sprint status (reactivate only on closed, delete
 * only on non-active, close only on active-all-done, etc.).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Project, Sprint, Tasks } from '@src/domain/models.ts';
import { getSprint, resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { getProjectById } from '@src/integration/persistence/project.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { FieldList } from '@src/integration/ui/tui/components/field-list.tsx';
import { StatusChip, chipKindForSprintStatus } from '@src/integration/ui/tui/components/status-chip.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter, type ViewEntry } from '@src/integration/ui/tui/views/router-context.ts';

interface Props {
  readonly sprintId?: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; sprint: Sprint; tasks: Tasks; project: Project | null }
  | { kind: 'error'; message: string };

interface Section {
  readonly label: string;
  readonly description: string;
  readonly destination: ViewEntry;
  readonly separator?: false;
}

interface Separator {
  readonly separator: true;
}

type Row = Section | Separator;

const TITLE = 'Sprint Details' as const;
const HINTS = [
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'open' },
] as const;

export function SprintShowView({ sprintId }: Props): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const id = await resolveSprintId(sprintId);
        const [sprint, tasks] = await Promise.all([getSprint(id), listTasks(id)]);
        const project = await getProjectById(sprint.projectId).catch(() => null);
        if (!ctl.cancelled) setState({ kind: 'ready', sprint, tasks, project });
      } catch (err) {
        if (!ctl.cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [sprintId]);

  const rows = useMemo<readonly Row[]>(() => {
    if (state.kind !== 'ready') return [];
    return buildRows(state.sprint, state.tasks);
  }, [state]);

  const sections = useMemo<readonly Section[]>(() => rows.filter((r): r is Section => r.separator !== true), [rows]);

  const [cursor, setCursor] = useState(0);

  useInput(
    (_input, key) => {
      if (sections.length === 0) return;
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(sections.length - 1, c + 1));
      else if (key.return) {
        const section = sections[cursor];
        if (section !== undefined) router.push(section.destination);
      }
    },
    { isActive: state.kind === 'ready' && sections.length > 0 }
  );

  return <ViewShell title={TITLE}>{renderBody(state, rows, sections, cursor)}</ViewShell>;
}

function renderBody(
  state: State,
  rows: readonly Row[],
  sections: readonly Section[],
  cursor: number
): React.JSX.Element {
  if (state.kind === 'loading') return <Spinner label="Loading sprint…" />;
  if (state.kind === 'error') return <ResultCard kind="error" title="Could not load sprint" lines={[state.message]} />;

  const { sprint, tasks, project } = state;
  const projectLabel = project ? `${project.displayName} (${project.name})` : sprint.projectId;
  const approved = sprint.tickets.filter((t) => t.requirementStatus === 'approved').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const activeSectionId = sections[cursor]?.destination.id;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{sprint.name}</Text>
        <Text>{'  '}</Text>
        <StatusChip label={sprint.status} kind={chipKindForSprintStatus(sprint.status)} />
      </Box>
      <Box marginTop={spacing.section}>
        <FieldList
          fields={[
            ['ID', sprint.id],
            ['Project', projectLabel],
            ['Created', sprint.createdAt],
            ['Activated', sprint.activatedAt ?? glyphs.emDash],
            ['Closed', sprint.closedAt ?? glyphs.emDash],
            ['Branch', sprint.branch ?? glyphs.emDash],
            ['Tickets', `${String(sprint.tickets.length)} total ${glyphs.inlineDot} ${String(approved)} approved`],
            ['Tasks', `${String(tasks.length)} total ${glyphs.inlineDot} ${String(done)} done`],
          ]}
        />
      </Box>
      <Box marginTop={spacing.section} flexDirection="column">
        <Text color={inkColors.muted} bold>
          Sections
        </Text>
        {rows.map((row, i) => (
          <RowRenderer key={i} row={row} isActive={row.separator !== true && row.destination.id === activeSectionId} />
        ))}
      </Box>
    </Box>
  );
}

function RowRenderer({ row, isActive }: { readonly row: Row; readonly isActive: boolean }): React.JSX.Element {
  if (row.separator === true) {
    return (
      <Box paddingLeft={spacing.indent}>
        <Text color={inkColors.muted} dimColor>
          {glyphs.sectionRule.repeat(2)}
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={spacing.indent}>
      <Text color={isActive ? inkColors.highlight : undefined} bold={isActive}>
        {isActive ? glyphs.actionCursor : ' '}
      </Text>
      <Text color={isActive ? inkColors.highlight : undefined} bold={isActive}>
        {' '}
        {row.label}
      </Text>
      <Text dimColor>{` ${glyphs.emDash} ${row.description}`}</Text>
    </Box>
  );
}

function buildRows(sprint: Sprint, tasks: Tasks): readonly Row[] {
  const rows: Row[] = [
    {
      label: 'Tickets',
      description: `${String(sprint.tickets.length)} ticket${sprint.tickets.length === 1 ? '' : 's'}`,
      destination: { id: 'ticket-list', props: { sprintId: sprint.id } },
    },
    {
      label: 'Tasks',
      description: `${String(tasks.length)} task${tasks.length === 1 ? '' : 's'}`,
      destination: { id: 'task-list', props: { sprintId: sprint.id } },
    },
    {
      label: 'Progress log',
      description: 'Activity + AI notes',
      destination: { id: 'progress-show', props: { sprintId: sprint.id } },
    },
    {
      label: 'Evaluations',
      description: 'Autonomous code-review critiques',
      destination: { id: 'evaluations', props: { sprintId: sprint.id } },
    },
    {
      label: 'Feedback',
      description: 'Free-form user feedback history',
      destination: { id: 'feedback', props: { sprintId: sprint.id } },
    },
  ];

  const allTasksDone = tasks.length > 0 && tasks.every((t) => t.status === 'done');
  const hasAction = sprint.status !== 'active' || allTasksDone;

  if (hasAction) {
    rows.push({ separator: true });
  }

  if (sprint.status === 'closed') {
    rows.push({
      label: 'Reactivate',
      description: 'Return this sprint to active status',
      destination: { id: 'sprint-reactivate', props: { sprintId: sprint.id } },
    });
  }

  if (sprint.status !== 'active') {
    rows.push({
      label: 'Delete',
      description: 'Permanently remove this sprint',
      destination: { id: 'sprint-delete', props: { sprintId: sprint.id } },
    });
  }

  if (sprint.status === 'active' && allTasksDone) {
    rows.push({
      label: 'Close',
      description: 'All tasks done — close the sprint',
      destination: { id: 'close-phase', props: { sprintId: sprint.id } },
    });
  }

  return rows;
}
