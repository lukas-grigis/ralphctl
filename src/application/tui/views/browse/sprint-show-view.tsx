/**
 * SprintShowView — detail view for a single sprint.
 *
 * Shows sprint metadata (FieldList) + StatusChip + nested ticket list.
 * Read-only. Press Esc to go back.
 *
 * Receives `sprintId: string` via router props.
 */

import React, { useEffect, useState } from 'react';
import { useViewInput } from '@src/application/tui/views/use-view-input.ts';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { FieldList } from '@src/application/tui/components/field-list.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { StatusChip, chipKindForSprintStatus } from '@src/application/tui/components/status-chip.tsx';
import { useViewHints } from '@src/application/tui/views/view-hints-context.tsx';
import { useRouterOptional } from '@src/application/tui/views/router-context.ts';
import { getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { ShowSprintUseCase } from '@src/business/usecases/sprint/show-sprint.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { getKeyFor } from '@src/application/tui/keyboard-map.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';

const SHOW_HINTS = [
  { key: 'Esc', action: 'back' },
  { key: getKeyFor('detail.edit'), action: 'edit' },
  { key: getKeyFor('list.remove'), action: 'remove' },
] as const;

function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function requirementLabel(status: 'pending' | 'approved'): string {
  return status === 'approved' ? 'approved' : 'pending';
}

interface Props {
  readonly sprintId?: string;
}

export function SprintShowView({ sprintId }: Props): React.JSX.Element {
  useViewHints(SHOW_HINTS);
  const router = useRouterOptional();
  const [sprint, setSprint] = useState<Sprint | null>(null);
  const [error, setError] = useState<string | null>(null);

  const KEY_REMOVE = getKeyFor('list.remove');

  useViewInput((input) => {
    if (!sprint || !router) return;
    if (input === KEY_REMOVE) {
      router.push({ id: 'sprint-remove', props: { sprintId: String(sprint.id) } });
    }
  });

  useEffect(() => {
    const cancel = { current: false };
    void (async () => {
      if (!sprintId) {
        setError('No sprint ID provided.');
        return;
      }
      try {
        const idResult = SprintId.parse(sprintId);
        if (!idResult.ok) {
          setError(idResult.error.message);
          return;
        }
        const deps = await getSharedDeps();
        const uc = new ShowSprintUseCase(deps.sprintRepo);
        const result = await uc.execute({ id: idResult.value });
        if (cancel.current) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setSprint(result.value);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, [sprintId]);

  if (sprint === null && error === null) {
    return (
      <ViewShell title="SPRINT">
        <Spinner label="Loading sprint…" />
      </ViewShell>
    );
  }

  if (error !== null) {
    return (
      <ViewShell title="SPRINT">
        <ResultCard
          kind="error"
          title="Sprint not found"
          lines={[error]}
          nextSteps={[{ action: 'Go back', description: 'press Esc' }]}
        />
      </ViewShell>
    );
  }

  if (sprint === null)
    return (
      <ViewShell title="SPRINT">
        <Box />
      </ViewShell>
    );

  const fields: [string, string][] = [
    ['ID', String(sprint.id)],
    ['Status', sprint.status.toUpperCase()],
    ['Project', String(sprint.projectName)],
    [
      'Repos',
      sprint.affectedRepositories.length > 0
        ? sprint.affectedRepositories.map(String).join(', ')
        : '— (set during plan)',
    ],
    ['Created', formatDate(String(sprint.createdAt))],
    ['Activated', formatDate(sprint.activatedAt !== null ? String(sprint.activatedAt) : null)],
    ['Closed', formatDate(sprint.closedAt !== null ? String(sprint.closedAt) : null)],
    ['Branch', sprint.branch ?? '—'],
    ['Tickets', String(sprint.tickets.length)],
  ];

  const nextStepsForStatus =
    sprint.status === 'draft'
      ? [{ action: 'Add tickets', description: "press 'h' then 'Add ticket'" }]
      : sprint.status === 'active'
        ? [{ action: 'Continue execution', description: "press 'h' then 'Start sprint'" }]
        : [];

  return (
    <ViewShell title="SPRINT">
      <Box flexDirection="column">
        {/* Header row: name + status chip */}
        <Box>
          <Text bold>{sprint.name}</Text>
          <Box marginLeft={spacing.indent}>
            <StatusChip label={sprint.status} kind={chipKindForSprintStatus(sprint.status)} />
          </Box>
        </Box>

        {/* Metadata */}
        <Box marginTop={spacing.section}>
          <FieldList fields={fields} />
        </Box>

        {/* Tickets */}
        {sprint.tickets.length > 0 ? (
          <Box flexDirection="column" marginTop={spacing.section}>
            <Text dimColor bold>
              Tickets
            </Text>
            {sprint.tickets.map((ticket) => (
              <Box key={String(ticket.id)} paddingLeft={spacing.indent} marginTop={0}>
                <Text color={inkColors.muted}>{glyphs.bulletListItem} </Text>
                <Text>{ticket.title}</Text>
                <Text>{'  '}</Text>
                <Text color={ticket.requirementStatus === 'approved' ? inkColors.success : inkColors.warning} bold>
                  [{requirementLabel(ticket.requirementStatus).toUpperCase()}]
                </Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Box marginTop={spacing.section}>
            <Text dimColor>No tickets yet.</Text>
          </Box>
        )}

        {nextStepsForStatus.length > 0 ? (
          <Box marginTop={spacing.actionBreak}>
            <ResultCard kind="info" title="Next steps" nextSteps={nextStepsForStatus} />
          </Box>
        ) : null}
      </Box>
    </ViewShell>
  );
}
