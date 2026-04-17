/**
 * ProjectEditView — native Ink flow for editing a project's display name
 * and description. Repository edits live in the dedicated repo workflow
 * views to keep each flow single-purpose.
 */

import React, { useMemo } from 'react';
import type { Project } from '@src/domain/models.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { listProjects, updateProject } from '@src/integration/persistence/project.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Edit Project' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'select' | 'display' | 'description' | 'saving' }
  | { kind: 'no-projects' }
  | { kind: 'done'; project: Project }
  | { kind: 'error'; message: string };

export function ProjectEditView(): React.JSX.Element {
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
        message: 'Which project?',
        choices: projects.map((p) => ({ label: `${p.displayName} (${p.name})`, value: p.name })),
      });
      const current = projects.find((p) => p.name === name);
      if (!current) throw new Error(`Project ${name} disappeared`);

      setPhase({ kind: 'running', step: 'display' });
      const display = await prompt.input({
        message: 'Display name:',
        default: current.displayName,
        validate: (v: string) => (v.trim().length > 0 ? true : 'Display name is required'),
      });

      setPhase({ kind: 'running', step: 'description' });
      const description = await prompt.input({
        message: 'Description (optional):',
        default: current.description ?? '',
      });

      setPhase({ kind: 'running', step: 'saving' });
      const trimmedDescription = description.trim();
      const project = await updateProject(name, {
        displayName: display.trim(),
        description: trimmedDescription.length > 0 ? trimmedDescription : undefined,
      });
      setPhase({ kind: 'done', project });
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
      return <ResultCard kind="info" title="No projects registered" />;
    case 'error':
      return <ResultCard kind="error" title="Could not update project" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Project updated"
          fields={[
            ['Name', phase.project.name],
            ['Display', phase.project.displayName],
            ['Description', phase.project.description ?? '(empty)'],
          ]}
        />
      );
  }
}

function stepLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  if (step === 'select') return 'Awaiting project selection…';
  if (step === 'display') return 'Awaiting display name…';
  if (step === 'description') return 'Awaiting description…';
  return 'Saving project…';
}
