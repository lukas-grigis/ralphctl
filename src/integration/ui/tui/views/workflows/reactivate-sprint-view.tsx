/**
 * ReactivateSprintView — return a closed sprint to active status.
 *
 * Confirm prompt → flips `status` back to `active`, clears `closedAt`.
 * Persistence-level `assertSprintStatus` can't help here (it guards draft /
 * active transitions only), so we set the fields directly via `saveSprint`.
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/application/bootstrap.ts';
import { getSprint, saveSprint } from '@src/integration/persistence/sprint.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

interface Props {
  readonly sprintId?: string;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'running'; step: 'confirm' | 'saving' }
  | { kind: 'done'; name: string; id: string }
  | { kind: 'cancelled' }
  | { kind: 'not-closed'; status: string }
  | { kind: 'missing-id' }
  | { kind: 'error'; message: string };

const TITLE = 'Reactivate Sprint' as const;
const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'back' },
  { key: 'Esc', action: 'back' },
] as const;

export function ReactivateSprintView({ sprintId }: Props): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'loading' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      if (!sprintId) {
        setPhase({ kind: 'missing-id' });
        return;
      }
      const sprint = await getSprint(sprintId);
      if (sprint.status !== 'closed') {
        setPhase({ kind: 'not-closed', status: sprint.status });
        return;
      }

      const prompt = getPrompt();
      setPhase({ kind: 'running', step: 'confirm' });
      const confirmed = await prompt.confirm({
        message: `Reactivate closed sprint "${sprint.name}"? (this sets status back to active)`,
        default: false,
      });
      if (!confirmed) {
        setPhase({ kind: 'cancelled' });
        return;
      }

      setPhase({ kind: 'running', step: 'saving' });
      await saveSprint({ ...sprint, status: 'active', closedAt: null });
      setPhase({ kind: 'done', name: sprint.name, id: sprint.id });
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
      return <Spinner label="Loading sprint…" />;
    case 'running':
      return <Spinner label={phase.step === 'confirm' ? 'Awaiting confirmation…' : 'Reactivating sprint…'} />;
    case 'cancelled':
      return <ResultCard kind="info" title="Reactivation cancelled" />;
    case 'missing-id':
      return <ResultCard kind="error" title="No sprint ID provided" />;
    case 'not-closed':
      return (
        <ResultCard
          kind="warning"
          title="Sprint is not closed"
          lines={[`Current status: ${phase.status}. Only closed sprints can be reactivated.`]}
        />
      );
    case 'error':
      return <ResultCard kind="error" title="Could not reactivate sprint" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Sprint reactivated"
          fields={[
            ['Name', phase.name],
            ['ID', phase.id],
          ]}
          nextSteps={[{ action: 'Continue Work', description: 'Home → Next' }]}
        />
      );
  }
}
