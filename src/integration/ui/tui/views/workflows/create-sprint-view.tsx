/**
 * CreateSprintView — native Ink flow for `sprint create`.
 *
 * Three steps: name prompt → set-current confirmation → create & set-current.
 * Owns its rendering end-to-end: no raw console.log, no plain-CLI output
 * bleeds into the alt-screen buffer.
 */

import React, { useMemo } from 'react';
import type { Sprint } from '@src/domain/models.ts';
import { getPrompt } from '@src/application/bootstrap.ts';
import { createSprint } from '@src/integration/persistence/sprint.ts';
import { setCurrentSprint } from '@src/integration/persistence/config.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Create Sprint' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'name' | 'current' | 'creating' }
  | { kind: 'done'; sprint: Sprint; setAsCurrent: boolean }
  | { kind: 'error'; message: string };

const RUNNING_LABEL: Record<Extract<Phase, { kind: 'running' }>['step'], string> = {
  name: 'Awaiting sprint name…',
  current: 'Awaiting confirmation…',
  creating: 'Creating sprint…',
};

export function CreateSprintView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'name' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      setPhase({ kind: 'running', step: 'name' });
      const rawName = await prompt.input({ message: 'Sprint name (optional):' });
      const trimmed = rawName.trim();
      const name = trimmed.length > 0 ? trimmed : undefined;

      setPhase({ kind: 'running', step: 'current' });
      const setAsCurrent = await prompt.confirm({ message: 'Set as current sprint?', default: true });

      setPhase({ kind: 'running', step: 'creating' });
      const sprint = await createSprint(name);
      if (setAsCurrent) await setCurrentSprint(sprint.id);

      setPhase({ kind: 'done', sprint, setAsCurrent });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  if (phase.kind === 'running') {
    return <Spinner label={RUNNING_LABEL[phase.step]} />;
  }
  if (phase.kind === 'error') {
    return <ResultCard kind="error" title="Could not create sprint" lines={[phase.message]} />;
  }
  const { sprint, setAsCurrent } = phase;
  return (
    <ResultCard
      kind="success"
      title="Sprint created"
      fields={[
        ['ID', sprint.id],
        ['Name', sprint.name],
        ['Status', sprint.status],
        ['Current', setAsCurrent ? 'Yes' : 'No'],
      ]}
      nextSteps={[
        setAsCurrent
          ? { action: 'Add tickets', description: 'sprint submenu → Tickets → Add' }
          : { action: `Set as current later`, description: `sprint current ${sprint.id}` },
      ]}
    />
  );
}
