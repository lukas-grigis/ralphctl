/**
 * DeleteSprintView — native Ink flow for `sprint delete`.
 *
 * Select sprint (if no `sprintId` prop) → show summary → confirm → delete.
 * Clears `currentSprint` in config if the deleted sprint was the current
 * target, so Home's pipeline map doesn't point at a ghost.
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { deleteSprint, getSprint, listSprints } from '@src/integration/persistence/sprint.ts';
import { getCurrentSprint, setCurrentSprint } from '@src/integration/persistence/config.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Delete Sprint' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

interface Props {
  readonly sprintId?: string;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'no-sprints' }
  | { kind: 'running'; step: 'select' | 'confirm' | 'deleting' }
  | { kind: 'done'; name: string; id: string; clearedCurrent: boolean }
  | { kind: 'cancelled' }
  | { kind: 'active-blocked'; name: string }
  | { kind: 'error'; message: string };

export function DeleteSprintView({ sprintId: initial }: Props): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'loading' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      let targetId = initial ?? null;
      if (!targetId) {
        const sprints = await listSprints();
        if (sprints.length === 0) {
          setPhase({ kind: 'no-sprints' });
          return;
        }
        setPhase({ kind: 'running', step: 'select' });
        targetId = await prompt.select<string>({
          message: 'Select sprint to delete:',
          choices: sprints.map((s) => ({
            label: `${s.id} — ${s.name} (${s.status})`,
            value: s.id,
          })),
        });
      }

      const sprint = await getSprint(targetId);
      if (sprint.status === 'active') {
        setPhase({ kind: 'active-blocked', name: sprint.name });
        return;
      }
      const tasks = await listTasks(targetId).catch(() => []);

      setPhase({ kind: 'running', step: 'confirm' });
      const confirmed = await prompt.confirm({
        message: `Delete "${sprint.name}" (${String(sprint.tickets.length)} tickets, ${String(tasks.length)} tasks)? This cannot be undone.`,
        default: false,
      });

      if (!confirmed) {
        setPhase({ kind: 'cancelled' });
        return;
      }

      // Second confirm — destructive, irreversible. One accidental Enter
      // shouldn't be enough.
      const reconfirmed = await prompt.confirm({
        message: `Really delete "${sprint.name}"? All sprint data (tickets, tasks, progress, evaluations) will be removed.`,
        default: false,
      });
      if (!reconfirmed) {
        setPhase({ kind: 'cancelled' });
        return;
      }

      setPhase({ kind: 'running', step: 'deleting' });
      const currentId = await getCurrentSprint();
      await deleteSprint(targetId);
      const clearedCurrent = currentId === targetId;
      if (clearedCurrent) await setCurrentSprint(null);

      setPhase({ kind: 'done', name: sprint.name, id: sprint.id, clearedCurrent });
    },
  });

  const running = phase.kind === 'running' || phase.kind === 'loading';
  const hints = useMemo(() => (running ? HINTS_RUNNING : HINTS_DONE), [running]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'loading':
      return <Spinner label="Loading sprints…" />;
    case 'no-sprints':
      return <ResultCard kind="info" title="No sprints to delete" />;
    case 'running':
      return <Spinner label={runningLabel(phase.step)} />;
    case 'cancelled':
      return <ResultCard kind="info" title="Deletion cancelled" />;
    case 'active-blocked':
      return (
        <ResultCard
          kind="warning"
          title="Cannot delete an active sprint"
          lines={[`"${phase.name}" is active — close it before deleting.`]}
        />
      );
    case 'error':
      return <ResultCard kind="error" title="Could not delete sprint" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Sprint deleted"
          fields={[
            ['Name', phase.name],
            ['ID', phase.id],
          ]}
          lines={phase.clearedCurrent ? ['Current sprint pointer was cleared.'] : undefined}
        />
      );
  }
}

function runningLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  if (step === 'select') return 'Awaiting selection…';
  if (step === 'confirm') return 'Awaiting confirmation…';
  return 'Deleting sprint…';
}
