/**
 * EvaluationShowView — full critique from the evaluator sidecar file.
 *
 * Reads `<sprintDir>/evaluations/<taskId>.md` and renders it as plain text.
 * Falls back to the `evaluationOutput` preview stored on the task if the
 * sidecar is missing (older sprints pre-sidecar support).
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { Task } from '@src/domain/models.ts';
import { resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { getTask } from '@src/integration/persistence/task.ts';
import { getEvaluationFilePath } from '@src/integration/persistence/paths.ts';
import { readTextFile } from '@src/integration/persistence/storage.ts';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { StatusChip, type StatusKind } from '@src/integration/ui/tui/components/status-chip.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';

interface Props {
  readonly sprintId?: string;
  readonly taskId?: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; task: Task; content: string }
  | { kind: 'error'; message: string };

const TITLE = 'Evaluation' as const;
const HINTS = [] as const;
const MAX_LINES = 200;

function kindFor(status: Task['evaluationStatus']): StatusKind {
  if (status === 'passed') return 'success';
  if (status === 'failed') return 'error';
  return 'warning';
}

export function EvaluationShowView({ sprintId, taskId }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        if (!taskId) throw new Error('No task ID provided');
        const id = await resolveSprintId(sprintId);
        const task = await getTask(taskId, id);
        let content = task.evaluationOutput ?? '';
        const sidecar = task.evaluationFile ?? getEvaluationFilePath(id, task.id);
        const fileResult = await readTextFile(sidecar);
        if (fileResult.ok) content = fileResult.value;
        if (!ctl.cancelled) setState({ kind: 'ready', task, content });
      } catch (err) {
        if (!ctl.cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [sprintId, taskId]);

  return <ViewShell title={TITLE}>{renderBody(state)}</ViewShell>;
}

function renderBody(state: State): React.JSX.Element {
  if (state.kind === 'loading') return <Spinner label="Loading evaluation…" />;
  if (state.kind === 'error')
    return <ResultCard kind="error" title="Could not load evaluation" lines={[state.message]} />;

  const { task, content } = state;
  const lines = content.split('\n');
  const tail = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{task.name}</Text>
        <Text>{'  '}</Text>
        <StatusChip label={task.evaluationStatus ?? 'unknown'} kind={kindFor(task.evaluationStatus)} />
      </Box>
      {content.trim().length === 0 ? (
        <Box marginTop={spacing.section}>
          <Text color={inkColors.muted}>No evaluator output recorded.</Text>
        </Box>
      ) : (
        <Box marginTop={spacing.section} flexDirection="column">
          {lines.length > MAX_LINES ? (
            <Text dimColor>
              Showing last {String(MAX_LINES)} lines ({String(lines.length)} total)
            </Text>
          ) : null}
          {tail.map((line, i) => (
            <Text key={i} dimColor={line.trim().length === 0}>
              {line.length > 0 ? line : ' '}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
