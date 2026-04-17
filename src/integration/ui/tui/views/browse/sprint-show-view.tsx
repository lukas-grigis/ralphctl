/**
 * SprintShowView — detail card for a sprint.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Sprint, Tasks } from '@src/domain/models.ts';
import { getSprint, resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { glyphs, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { FieldList } from '@src/integration/ui/tui/components/field-list.tsx';
import { StatusChip, chipKindForSprintStatus } from '@src/integration/ui/tui/components/status-chip.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface Props {
  readonly sprintId?: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; sprint: Sprint; tasks: Tasks }
  | { kind: 'error'; message: string };

const TITLE = 'Sprint Details' as const;
const HINTS = [] as const;

export function SprintShowView({ sprintId }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const id = await resolveSprintId(sprintId);
        const [sprint, tasks] = await Promise.all([getSprint(id), listTasks(id)]);
        if (!ctl.cancelled) setState({ kind: 'ready', sprint, tasks });
      } catch (err) {
        if (!ctl.cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [sprintId]);

  return <ViewShell title={TITLE}>{renderBody(state)}</ViewShell>;
}

function renderBody(state: State): React.JSX.Element {
  if (state.kind === 'loading') return <Spinner label="Loading sprint…" />;
  if (state.kind === 'error') return <ResultCard kind="error" title="Could not load sprint" lines={[state.message]} />;

  const { sprint, tasks } = state;
  const approved = sprint.tickets.filter((t) => t.requirementStatus === 'approved').length;
  const done = tasks.filter((t) => t.status === 'done').length;

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
            ['Created', sprint.createdAt],
            ['Activated', sprint.activatedAt ?? glyphs.emDash],
            ['Closed', sprint.closedAt ?? glyphs.emDash],
            ['Branch', sprint.branch ?? glyphs.emDash],
            ['Tickets', `${String(sprint.tickets.length)} total ${glyphs.inlineDot} ${String(approved)} approved`],
            ['Tasks', `${String(tasks.length)} total ${glyphs.inlineDot} ${String(done)} done`],
          ]}
        />
      </Box>
    </Box>
  );
}
