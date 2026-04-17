/**
 * CreateSprintView — native Ink flow for `sprint create`.
 *
 * Flow: pick project (required) → name → set-current? → create & set-current.
 * Every sprint is scoped to exactly one project; `projectId` is persisted
 * on the sprint so tickets/tasks inherit it.
 */

import React, { useMemo } from 'react';
import type { Project, Sprint } from '@src/domain/models.ts';
import { getPrompt } from '@src/application/bootstrap.ts';
import { createSprint } from '@src/integration/persistence/sprint.ts';
import { setCurrentSprint } from '@src/integration/persistence/config.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
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
  | { kind: 'running'; step: 'project' | 'name' | 'current' | 'creating' }
  | { kind: 'no-projects' }
  | { kind: 'done'; sprint: Sprint; project: Project; setAsCurrent: boolean }
  | { kind: 'error'; message: string };

const RUNNING_LABEL: Record<Extract<Phase, { kind: 'running' }>['step'], string> = {
  project: 'Awaiting project selection…',
  name: 'Awaiting sprint name…',
  current: 'Awaiting confirmation…',
  creating: 'Creating sprint…',
};

export function CreateSprintView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'project' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      const projects = await listProjects();
      if (projects.length === 0) {
        setPhase({ kind: 'no-projects' });
        return;
      }

      setPhase({ kind: 'running', step: 'project' });
      const project =
        projects.length === 1 && projects[0]
          ? projects[0]
          : await (async () => {
              const id = await prompt.select<string>({
                message: 'Project:',
                choices: projects.map((p) => ({
                  label: `${p.displayName} (${String(p.repositories.length)} repo${p.repositories.length === 1 ? '' : 's'})`,
                  value: p.id,
                  description: p.description,
                })),
              });
              const found = projects.find((p) => p.id === id);
              if (!found) throw new Error('Project selection resolved to unknown id');
              return found;
            })();

      setPhase({ kind: 'running', step: 'name' });
      const rawName = await prompt.input({ message: 'Sprint name (optional):' });
      const trimmed = rawName.trim();
      const name = trimmed.length > 0 ? trimmed : undefined;

      setPhase({ kind: 'running', step: 'current' });
      const setAsCurrent = await prompt.confirm({ message: 'Set as current sprint?', default: true });

      setPhase({ kind: 'running', step: 'creating' });
      const sprint = await createSprint({ projectId: project.id, name });
      if (setAsCurrent) await setCurrentSprint(sprint.id);

      setPhase({ kind: 'done', sprint, project, setAsCurrent });
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
  if (phase.kind === 'no-projects') {
    return (
      <ResultCard
        kind="warning"
        title="No projects registered"
        nextSteps={[{ action: 'Register a project first', description: 'Browse → Projects → Add' }]}
      />
    );
  }
  if (phase.kind === 'error') {
    return <ResultCard kind="error" title="Could not create sprint" lines={[phase.message]} />;
  }
  const { sprint, project, setAsCurrent } = phase;
  return (
    <ResultCard
      kind="success"
      title="Sprint created"
      fields={[
        ['ID', sprint.id],
        ['Name', sprint.name],
        ['Project', `${project.displayName} (${project.name})`],
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
