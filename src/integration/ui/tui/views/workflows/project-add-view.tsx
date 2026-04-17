/**
 * ProjectAddView — native Ink flow for `project add`.
 *
 * Minimal happy path: name + display name + first repository path.
 * Additional repos can be added after via `project-repo-add`.
 */

import { resolve } from 'node:path';
import React, { useMemo } from 'react';
import type { Project } from '@src/domain/models.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { createProject, projectExists } from '@src/integration/persistence/project.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Add Project' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'name' | 'display' | 'repo-path' | 'saving' }
  | { kind: 'done'; project: Project }
  | { kind: 'error'; message: string };

const SLUG_RE = /^[a-z0-9-]+$/;

export function ProjectAddView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'name' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      setPhase({ kind: 'running', step: 'name' });
      const name = await prompt.input({
        message: 'Project slug (lowercase alphanumeric + hyphens):',
        validate: async (v: string) => {
          const slug = v.trim();
          if (!SLUG_RE.test(slug)) return 'Use lowercase letters, digits, and hyphens only';
          if (await projectExists(slug)) return `A project named "${slug}" already exists`;
          return true;
        },
      });

      setPhase({ kind: 'running', step: 'display' });
      const display = await prompt.input({
        message: 'Display name:',
        default: name.trim(),
        validate: (v: string) => (v.trim().length > 0 ? true : 'Display name is required'),
      });

      setPhase({ kind: 'running', step: 'repo-path' });
      const repoPath = await prompt.input({
        message: 'First repository path (absolute or ~/…):',
        validate: (v: string) => (v.trim().length > 0 ? true : 'A repository path is required'),
      });
      const absolute = resolve(repoPath.trim().replace(/^~(\/|$)/, `${process.env['HOME'] ?? ''}$1`));
      const repoName = absolute.split(/[\\/]/).pop() ?? 'repo';

      setPhase({ kind: 'running', step: 'saving' });
      const project = await createProject({
        name: name.trim(),
        displayName: display.trim(),
        repositories: [{ name: repoName, path: absolute }],
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
    case 'error':
      return (
        <ResultCard
          kind="error"
          title={phase.message.startsWith('A project named') ? 'Project already exists' : 'Could not add project'}
          lines={[phase.message]}
        />
      );
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Project registered"
          fields={[
            ['Name', phase.project.name],
            ['Display', phase.project.displayName],
            ['Repos', String(phase.project.repositories.length)],
          ]}
          nextSteps={[{ action: 'Add more repositories', description: 'Browse → Projects → Add Repository' }]}
        />
      );
  }
}

function stepLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  if (step === 'name') return 'Awaiting project slug…';
  if (step === 'display') return 'Awaiting display name…';
  if (step === 'repo-path') return 'Awaiting repository path…';
  return 'Saving project…';
}
