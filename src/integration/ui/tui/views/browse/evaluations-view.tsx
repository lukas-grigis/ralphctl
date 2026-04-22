/**
 * EvaluationsView — list tasks in a sprint that have evaluator output.
 *
 * Enter opens `evaluation-show` for the picked task. Read-only.
 */

import React, { useEffect, useState } from 'react';
import type { Task } from '@src/domain/models.ts';
import { resolveSprintId } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
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
  | { kind: 'ready'; sprintId: string; tasks: readonly Task[] }
  | { kind: 'error'; message: string };

const TITLE = 'Evaluations' as const;
const HINTS = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
] as const;

function hasEvaluation(task: Task): boolean {
  return task.evaluationStatus !== undefined || task.evaluationFile !== undefined;
}

function statusColor(status: NonNullable<Task['evaluationStatus']> | undefined): string | undefined {
  if (!status) return undefined;
  if (status === 'passed') return inkColors.success;
  if (status === 'failed') return inkColors.error;
  return inkColors.warning;
}

function previewLine(task: Task): string {
  const raw = task.evaluationOutput ?? '';
  const first = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
  return first.trim() || '—';
}

const COLUMNS: readonly ListColumn<Task>[] = [
  {
    header: 'Status',
    cell: (t) => `[${(t.evaluationStatus ?? '—').toUpperCase()}]`,
    width: 12,
    color: (t) => statusColor(t.evaluationStatus),
  },
  { header: 'Task', cell: (t) => t.name, width: 28 },
  { header: 'Preview', cell: previewLine, flex: true },
];

export function EvaluationsView({ sprintId }: Props): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  useViewHints(HINTS);

  useEffect(() => {
    const ctl = { cancelled: false };
    void (async () => {
      try {
        const id = await resolveSprintId(sprintId);
        const all = await listTasks(id);
        const tasks = all.filter(hasEvaluation);
        if (ctl.cancelled) return;
        if (tasks.length === 0) setState({ kind: 'empty' });
        else setState({ kind: 'ready', sprintId: id, tasks });
      } catch (err) {
        if (ctl.cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.cancelled = true;
    };
  }, [sprintId]);

  return (
    <ViewShell title={TITLE}>
      {state.kind === 'loading' ? (
        <Spinner label="Loading evaluations…" />
      ) : state.kind === 'empty' ? (
        <ResultCard kind="info" title="No evaluations yet" lines={['Run the executor to collect evaluator output.']} />
      ) : state.kind === 'error' ? (
        <ResultCard kind="error" title="Could not load evaluations" lines={[state.message]} />
      ) : (
        <ListView<Task>
          rows={state.tasks}
          columns={COLUMNS}
          onSelect={(t) => {
            router.push({ id: 'evaluation-show', props: { sprintId: state.sprintId, taskId: t.id } });
          }}
        />
      )}
    </ViewShell>
  );
}
