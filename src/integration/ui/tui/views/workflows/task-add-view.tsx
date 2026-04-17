/**
 * TaskAddView — native Ink flow for `task add`.
 *
 * Flow: pick project path (from registered projects) → name → (optional)
 * description → commit. Bypasses the detailed "steps / verification / ticket /
 * blockedBy" surface of the CLI command — those are planner-generated in
 * practice, and manually-added tasks are typically simple one-offs.
 */

import React, { useMemo } from 'react';
import type { Task } from '@src/domain/models.ts';
import { getPrompt } from '@src/application/bootstrap.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
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
  | { kind: 'running'; step: 'project-path' | 'name' | 'description' | 'saving' }
  | { kind: 'no-projects' }
  | { kind: 'no-draft-sprint' }
  | { kind: 'done'; task: Task }
  | { kind: 'error'; message: string };

export function TaskAddView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'project-path' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      const sprint = await getCurrentSprintOrThrow();
      if (sprint.status !== 'draft') {
        setPhase({ kind: 'no-draft-sprint' });
        return;
      }

      const projects = await listProjects();
      const pathsByProject = projects.flatMap((p) =>
        p.repositories.map((r) => ({ projectName: p.name, repoName: r.name, path: r.path }))
      );
      if (pathsByProject.length === 0) {
        setPhase({ kind: 'no-projects' });
        return;
      }

      setPhase({ kind: 'running', step: 'project-path' });
      const projectPath = await prompt.select<string>({
        message: 'Where does this task run?',
        choices: pathsByProject.map((e) => ({
          label: `[${e.projectName}] ${e.repoName}`,
          value: e.path,
          description: e.path,
        })),
      });

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
        projectPath,
      });
      setPhase({ kind: 'done', task });
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
      return <ResultCard kind="warning" title="Register a project first" />;
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
            ['Project Path', phase.task.projectPath],
          ]}
        />
      );
  }
}

function stepLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  if (step === 'project-path') return 'Awaiting project path…';
  if (step === 'name') return 'Awaiting task name…';
  if (step === 'description') return 'Awaiting description…';
  return 'Saving task…';
}
