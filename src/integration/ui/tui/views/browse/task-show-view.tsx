/**
 * TaskShowView — detail card for a task.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Task } from '@src/domain/models.ts';
import { getTask } from '@src/integration/persistence/task.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { FieldList } from '@src/integration/ui/tui/components/field-list.tsx';
import { StatusChip, chipKindForTaskStatus } from '@src/integration/ui/tui/components/status-chip.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface Props {
  readonly taskId?: string;
}

type State = { kind: 'loading' } | { kind: 'ready'; task: Task } | { kind: 'error'; message: string };

const TITLE = 'Task Details' as const;
const HINTS = [] as const;

export function TaskShowView({ taskId }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      if (!taskId) {
        setState({ kind: 'error', message: 'No task ID provided' });
        return;
      }
      try {
        const task = await getTask(taskId);
        if (!ctl.cancelled) setState({ kind: 'ready', task });
      } catch (err) {
        if (!ctl.cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [taskId]);

  return <ViewShell title={TITLE}>{renderBody(state)}</ViewShell>;
}

function renderBody(state: State): React.JSX.Element {
  if (state.kind === 'loading') return <Spinner label="Loading task…" />;
  if (state.kind === 'error') return <ResultCard kind="error" title="Could not load task" lines={[state.message]} />;

  const { task } = state;
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{task.name}</Text>
        <Text>{'  '}</Text>
        <StatusChip label={task.status} kind={chipKindForTaskStatus(task.status)} />
      </Box>
      <Box marginTop={spacing.section}>
        <FieldList
          fields={[
            ['ID', task.id],
            ['Order', String(task.order)],
            ['Project Path', task.projectPath],
            ['Ticket', task.ticketId ?? glyphs.emDash],
            ['Blocked By', task.blockedBy.length > 0 ? task.blockedBy.join(', ') : glyphs.emDash],
            ['Verified', task.verified ? 'yes' : 'no'],
            ['Evaluated', task.evaluated ? `yes (${task.evaluationStatus ?? glyphs.emDash})` : 'no'],
          ]}
        />
      </Box>
      {task.description ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <Text color={inkColors.muted} bold>
            Description
          </Text>
          <Box paddingLeft={spacing.indent}>
            <Text>{task.description}</Text>
          </Box>
        </Box>
      ) : null}
      {task.steps.length > 0 ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <Text color={inkColors.muted} bold>
            Steps
          </Text>
          {task.steps.map((step, i) => (
            <Box key={i} paddingLeft={spacing.indent}>
              <Text dimColor>{String(i + 1).padStart(2, ' ')}. </Text>
              <Text>{step}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {task.verificationCriteria.length > 0 ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <Text color={inkColors.muted} bold>
            Verification
          </Text>
          {task.verificationCriteria.map((v, i) => (
            <Box key={i} paddingLeft={spacing.indent}>
              <Text dimColor>{glyphs.bulletListItem} </Text>
              <Text>{v}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
