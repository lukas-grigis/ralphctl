/**
 * DeleteSprintView — native Ink flow for `sprint delete`.
 *
 * Selection + validation happen here; once a target sprint is chosen, the
 * shared {@link RemovalWorkflow} component drives the confirm + delete + done
 * state machine. Clears `currentSprint` in config if the deleted sprint was
 * the current target, so Home's pipeline map doesn't point at a ghost.
 */

import React, { useEffect, useState } from 'react';
import type { Sprint } from '@src/domain/models.ts';
import { PromptCancelledError } from '@src/business/ports/prompt.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { getCurrentSprint, setCurrentSprint } from '@src/integration/persistence/config.ts';
import { deleteSprint, getSprint, listSprints } from '@src/integration/persistence/sprint.ts';
import { listTasks } from '@src/integration/persistence/task.ts';
import { RemovalWorkflow } from '@src/integration/ui/tui/components/removal-workflow.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';

const TITLE = 'Delete Sprint' as const;

interface Props {
  readonly sprintId?: string;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'selecting' }
  | { kind: 'no-sprints' }
  | { kind: 'active-blocked'; name: string }
  | { kind: 'ready'; sprint: Sprint; taskCount: number }
  | { kind: 'error'; message: string };

export function DeleteSprintView({ sprintId: initial }: Props): React.JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    setStarted(true);
    void (async (): Promise<void> => {
      try {
        const prompt = getPrompt();
        let targetId = initial ?? null;

        if (!targetId) {
          const sprints = await listSprints();
          if (sprints.length === 0) {
            setPhase({ kind: 'no-sprints' });
            return;
          }
          setPhase({ kind: 'selecting' });
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

        setPhase({ kind: 'ready', sprint, taskCount: tasks.length });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          router.pop();
          return;
        }
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [started, initial, router]);

  if (phase.kind === 'ready') {
    const { sprint, taskCount } = phase;
    const ticketCount = sprint.tickets.length;
    const confirmMessage = `Delete "${sprint.name}" (${String(ticketCount)} ${pluralize('ticket', ticketCount)}, ${String(
      taskCount
    )} ${pluralize('task', taskCount)})? All sprint data — tickets, tasks, progress, evaluations — will be removed. This cannot be undone.`;
    return (
      <RemovalWorkflow
        entityLabel={TITLE}
        confirmMessage={confirmMessage}
        onConfirm={async (): Promise<void> => {
          const currentId = await getCurrentSprint();
          await deleteSprint(sprint.id);
          if (currentId === sprint.id) await setCurrentSprint(null);
        }}
        successMessage={`Sprint "${sprint.name}" deleted`}
        onDone={() => {
          router.pop();
        }}
      />
    );
  }

  return <ViewShell title={TITLE}>{renderPre(phase)}</ViewShell>;
}

function renderPre(phase: Exclude<Phase, { kind: 'ready' }>): React.JSX.Element {
  switch (phase.kind) {
    case 'loading':
      return <Spinner label="Loading sprints…" />;
    case 'selecting':
      return <Spinner label="Awaiting selection…" />;
    case 'no-sprints':
      return <ResultCard kind="info" title="No sprints to delete" />;
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
  }
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}
