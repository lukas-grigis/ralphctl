/**
 * TaskAddView — native Ink flow for `task add`.
 *
 * Flow: pick repo (from sprint's project) → name → (optional) description →
 * commit. Auto-selects the repo if the sprint's project has only one.
 */

import React, { useMemo } from 'react';
import type { Repository, Task } from '@src/domain/models.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { getProjectById } from '@src/integration/persistence/project.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { addTask } from '@src/integration/persistence/task.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Add Task' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'repo' | 'name' | 'description' | 'saving' }
  | { kind: 'no-project' }
  | { kind: 'no-draft-sprint' }
  | { kind: 'done'; task: Task; repo: Repository }
  | { kind: 'error'; message: string };

export function TaskAddView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'repo' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      const sprint = await getCurrentSprintOrThrow();
      if (sprint.status !== 'draft') {
        setPhase({ kind: 'no-draft-sprint' });
        return;
      }

      let project;
      try {
        project = await getProjectById(sprint.projectId);
      } catch {
        setPhase({ kind: 'no-project' });
        return;
      }

      const repos = project.repositories;
      if (repos.length === 0) {
        setPhase({ kind: 'no-project' });
        return;
      }

      setPhase({ kind: 'running', step: 'repo' });
      let repo: Repository;
      if (repos.length === 1 && repos[0]) {
        repo = repos[0];
      } else {
        const repoId = await prompt.select<string>({
          message: 'Which repo runs this task?',
          choices: repos.map((r) => ({
            label: r.name,
            value: r.id,
            description: r.path,
          })),
        });
        const picked = repos.find((r) => r.id === repoId);
        if (!picked) throw new Error('Repo selection resolved to unknown id');
        repo = picked;
      }

      setPhase({ kind: 'running', step: 'name' });
      const name = await prompt.input({
        message: 'Task name:',
        validate: (v: string) => (v.trim().length > 0 ? true : 'Name is required'),
      });

      setPhase({ kind: 'running', step: 'description' });
      const description = await prompt.editor({
        message: 'Description (optional)',
      });

      setPhase({ kind: 'running', step: 'saving' });
      const trimmedDescription = description?.trim() ?? '';
      const task = await addTask({
        name: name.trim(),
        description: trimmedDescription.length > 0 ? trimmedDescription : undefined,
        repoId: repo.id,
      });
      setPhase({ kind: 'done', task, repo });
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
    case 'no-project':
      return <ResultCard kind="warning" title="Sprint's project is missing or has no repos" />;
    case 'no-draft-sprint':
      return <ResultCard kind="warning" title="Current sprint is not a draft" />;
    case 'error':
      return <ResultCard kind="error" title="Could not add task" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Task added"
          fields={[
            ['ID', phase.task.id],
            ['Name', phase.task.name],
            ['Order', String(phase.task.order)],
            ['Repo', `${phase.repo.name} (${phase.repo.path})`],
          ]}
        />
      );
  }
}

function stepLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  if (step === 'repo') return 'Awaiting repo selection…';
  if (step === 'name') return 'Awaiting task name…';
  if (step === 'description') return 'Awaiting description…';
  return 'Saving task…';
}
