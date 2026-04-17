/**
 * ProjectRemoveView — native Ink flow for `project remove`.
 */

import React, { useMemo } from 'react';
import { getPrompt } from '@src/application/bootstrap.ts';
import { listProjects, removeProject } from '@src/integration/persistence/project.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Remove Project' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'select' | 'confirm' | 'removing' }
  | { kind: 'no-projects' }
  | { kind: 'cancelled' }
  | { kind: 'done'; name: string }
  | { kind: 'error'; message: string };

export function ProjectRemoveView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'select' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      const projects = await listProjects();
      if (projects.length === 0) {
        setPhase({ kind: 'no-projects' });
        return;
      }

      setPhase({ kind: 'running', step: 'select' });
      const name = await prompt.select<string>({
        message: 'Select project to remove:',
        choices: projects.map((p) => ({
          label: `${p.displayName} (${p.name})`,
          value: p.name,
          description: `${String(p.repositories.length)} repo${p.repositories.length === 1 ? '' : 's'}`,
        })),
      });

      setPhase({ kind: 'running', step: 'confirm' });
      const ok = await prompt.confirm({
        message: `Remove project "${name}"? This cannot be undone.`,
        default: false,
      });
      if (!ok) {
        setPhase({ kind: 'cancelled' });
        return;
      }

      setPhase({ kind: 'running', step: 'removing' });
      await removeProject(name);
      setPhase({ kind: 'done', name });
    },
  });

  const hints = useMemo(() => (phase.kind === 'running' ? HINTS_RUNNING : HINTS_DONE), [phase.kind]);
  useViewHints(hints);

  return <ViewShell title={TITLE}>{renderBody(phase)}</ViewShell>;
}

function renderBody(phase: Phase): React.JSX.Element {
  switch (phase.kind) {
    case 'running':
      return <Spinner label={stepLabel(phase.step)} />;
    case 'no-projects':
      return <ResultCard kind="info" title="No projects to remove" />;
    case 'cancelled':
      return <ResultCard kind="info" title="Removal cancelled" />;
    case 'error':
      return <ResultCard kind="error" title="Could not remove project" lines={[phase.message]} />;
    case 'done':
      return <ResultCard kind="success" title="Project removed" fields={[['Name', phase.name]]} />;
  }
}

function stepLabel(step: 'select' | 'confirm' | 'removing'): string {
  if (step === 'select') return 'Awaiting project selection…';
  if (step === 'confirm') return 'Awaiting confirmation…';
  return 'Removing project…';
}
