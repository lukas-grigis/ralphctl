/**
 * ProjectRepoAddView — native Ink flow for `project repo add`.
 */

import { resolve } from 'node:path';
import React, { useMemo } from 'react';
import type { Project } from '@src/domain/models.ts';
import { getPrompt } from '@src/application/bootstrap.ts';
import { addProjectRepo, listProjects } from '@src/integration/persistence/project.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Add Repository' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'project' | 'path' | 'saving' }
  | { kind: 'no-projects' }
  | { kind: 'done'; project: Project; repoName: string }
  | { kind: 'error'; message: string };

export function ProjectRepoAddView(): React.JSX.Element {
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

      setPhase({ kind: 'running', step: 'path' });
      const repoPath = await prompt.input({
        message: 'Repository path:',
        validate: (v: string) => (v.trim().length > 0 ? true : 'Path is required'),
      });
      const absolute = resolve(repoPath.trim().replace(/^~(\/|$)/, `${process.env['HOME'] ?? ''}$1`));
      const repoName = absolute.split(/[\\/]/).pop() ?? 'repo';

      setPhase({ kind: 'running', step: 'saving' });
      const project = await addProjectRepo(projectName, { name: repoName, path: absolute });
      setPhase({ kind: 'done', project, repoName });
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
      return <ResultCard kind="warning" title="No projects to add a repository to" />;
    case 'error':
      return <ResultCard kind="error" title="Could not add repository" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Repository added"
          fields={[
            ['Project', phase.project.displayName],
            ['Repo', phase.repoName],
            ['Total repos', String(phase.project.repositories.length)],
          ]}
        />
      );
  }
}

function stepLabel(step: 'project' | 'path' | 'saving'): string {
  if (step === 'project') return 'Awaiting project selection…';
  if (step === 'path') return 'Awaiting repository path…';
  return 'Saving repository…';
}
