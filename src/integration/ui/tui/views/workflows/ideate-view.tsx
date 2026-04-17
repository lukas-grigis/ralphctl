/**
 * IdeateView — native Ink wrapper for the ideate pipeline.
 *
 * Prompts the user for an idea (title + description + project), then runs
 * `createIdeatePipeline` via `executePipeline`. The AI session fires
 * mid-pipeline — we `withSuspendedTui` around `executePipeline` so Ink
 * steps aside for the duration and restores after.
 */

import React, { useMemo } from 'react';
import type { IdeationSummary } from '@src/business/usecases/plan.ts';
import { getPrompt, getSharedDeps } from '@src/integration/bootstrap.ts';
import { createIdeatePipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { withSuspendedTui } from '@src/integration/ui/tui/runtime/suspend.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

const TITLE = 'Ideate' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'title' | 'description' | 'project' | 'running-pipeline' }
  | { kind: 'no-projects' }
  | { kind: 'no-draft-sprint' }
  | { kind: 'done'; summary: IdeationSummary }
  | { kind: 'error'; message: string };

export function IdeateView(): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'title' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();
      const shared = getSharedDeps();

      const sprint = await getCurrentSprintOrThrow();
      if (sprint.status !== 'draft') {
        setPhase({ kind: 'no-draft-sprint' });
        return;
      }

      const projects = await listProjects();
      if (projects.length === 0) {
        setPhase({ kind: 'no-projects' });
        return;
      }

      setPhase({ kind: 'running', step: 'title' });
      const title = await prompt.input({
        message: 'Idea title:',
        validate: (v: string) => (v.trim().length > 0 ? true : 'Title is required'),
      });

      setPhase({ kind: 'running', step: 'description' });
      const description = await prompt.editor({
        message: 'Idea description',
      });

      // TODO(model-migration): ideate pipeline should derive project from
      // `sprint.projectId` — once the business-layer agent exposes that, drop
      // this prompt and pass the sprint's project directly.
      setPhase({ kind: 'running', step: 'project' });
      const projectName =
        projects.length === 1 && projects[0]
          ? projects[0].name
          : await prompt.select<string>({
              message: 'Which project?',
              choices: projects.map((p) => ({ label: p.displayName, value: p.name })),
            });

      setPhase({ kind: 'running', step: 'running-pipeline' });
      const pipelineDefinition = createIdeatePipeline(
        shared,
        { title: title.trim(), description: description?.trim() ?? '' },
        { project: projectName }
      );
      const result = await withSuspendedTui(() => executePipeline(pipelineDefinition, { sprintId: sprint.id }));
      if (!result.ok) {
        setPhase({ kind: 'error', message: result.error.message });
        return;
      }
      const summary = result.value.context.ideaSummary;
      if (!summary) {
        setPhase({ kind: 'error', message: 'Ideation finished without producing a summary.' });
        return;
      }
      setPhase({ kind: 'done', summary });
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
      return <ResultCard kind="error" title="Ideation failed" lines={[phase.message]} />;
    case 'done':
      return (
        <ResultCard
          kind="success"
          title="Ideation finished"
          fields={[
            ['Ticket ID', phase.summary.ticketId],
            ['Tasks', String(phase.summary.importedTasks)],
          ]}
          lines={['Check Browse → Tasks to see the generated tasks.']}
        />
      );
  }
}

function stepLabel(step: Extract<Phase, { kind: 'running' }>['step']): string {
  if (step === 'title') return 'Awaiting idea title…';
  if (step === 'description') return 'Awaiting idea description…';
  if (step === 'project') return 'Awaiting project selection…';
  return 'Running ideation session…';
}
