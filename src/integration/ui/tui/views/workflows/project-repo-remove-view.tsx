/**
 * ProjectRepoRemoveView — native Ink flow for `project repo remove`.
 */

import React, { useMemo } from 'react';
import type { Project } from '@src/domain/models.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { listProjects, removeProjectRepo } from '@src/integration/persistence/project.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Remove Repository' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'project' | 'repo' | 'confirm' | 'removing' }
  | { kind: 'no-projects' }
  | { kind: 'no-repos' }
  | { kind: 'cancelled' }
  | { kind: 'done'; project: Project; repoName: string }
  | { kind: 'error'; message: string };

export function ProjectRepoRemoveView(): React.JSX.Element {
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
      const projectName =
        projects.length === 1 && projects[0]
          ? projects[0].name
          : await prompt.select<string>({
              message: 'Which project?',
              choices: projects.map((p) => ({ label: p.displayName, value: p.name })),
            });

      const project = projects.find((p) => p.name === projectName);
      if (!project || project.repositories.length === 0) {
        setPhase({ kind: 'no-repos' });
        return;
      }

      setPhase({ kind: 'running', step: 'repo' });
      const repoPath = await prompt.select<string>({
        message: 'Repository to remove:',
        choices: project.repositories.map((r) => ({ label: r.name, value: r.path, description: r.path })),
      });
      const repoName = project.repositories.find((r) => r.path === repoPath)?.name ?? repoPath;

      setPhase({ kind: 'running', step: 'confirm' });
      const ok = await prompt.confirm({
        message: `Remove repository "${repoName}" from ${project.displayName}?`,
        default: false,
      });
      if (!ok) {
        setPhase({ kind: 'cancelled' });
        return;
      }

      setPhase({ kind: 'running', step: 'removing' });
      const updated = await removeProjectRepo(projectName, repoPath);
      setPhase({ kind: 'done', project: updated, repoName });
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
      return <ResultCard kind="info" title="No projects" />;
    case 'no-repos':
      return <ResultCard kind="info" title="Project has no repositories" />;
    case 'cancelled':
      return <ResultCard kind="info" title="Removal cancelled" />;
    case 'error':
      return <ResultCard kind="error" title="Could not remove repository" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Repository removed"
          fields={[
            ['Project', phase.project.displayName],
            ['Repo', phase.repoName],
            ['Remaining', String(phase.project.repositories.length)],
          ]}
        />
      );
  }
}

function stepLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  if (step === 'project') return 'Awaiting project selection…';
  if (step === 'repo') return 'Awaiting repository selection…';
  if (step === 'confirm') return 'Awaiting confirmation…';
  return 'Removing repository…';
}
