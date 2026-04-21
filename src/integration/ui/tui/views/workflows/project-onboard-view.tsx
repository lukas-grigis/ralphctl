/**
 * ProjectOnboardView — Ink flow for `project onboard`.
 *
 * Walks the user through selecting a project (and optionally a repo), runs
 * the onboard pipeline to produce a project context file + check-script
 * proposal, and hands the proposal to the Ink multi-line editor for review
 * before writing.
 *
 * When `projectName` is passed via route params (e.g. the `o` hotkey on the
 * projects list), the project-selection prompt is skipped entirely.
 */

import React, { useMemo } from 'react';
import { getSharedDeps } from '@src/integration/bootstrap.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { createOnboardPipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import type { OnboardContext, OnboardOptions } from '@src/business/pipelines/onboard.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './use-workflow.ts';

interface Props {
  /** Pre-selected project name (from router params). Skips the picker when set. */
  readonly projectName?: string;
  /** Pre-selected repo name within the project (from router params). Skips the repo picker when set. */
  readonly repo?: string;
}

const TITLE = 'Onboard Repository' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'cancel' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'back' },
] as const;

type Phase =
  | { kind: 'running'; step: 'select-project' | 'onboarding' }
  | { kind: 'no-projects' }
  | {
      kind: 'done';
      projectName: string;
      writtenPath?: string;
      checkScript?: string | null;
      driftWarnings?: string[];
      lowConfidence: boolean;
      alreadyCurrent?: boolean;
    }
  | { kind: 'error'; message: string };

export function ProjectOnboardView({
  projectName: preselectedProject,
  repo: preselectedRepo,
}: Props = {}): React.JSX.Element {
  const { phase } = useWorkflow<Phase>({
    initial: preselectedProject ? { kind: 'running', step: 'onboarding' } : { kind: 'running', step: 'select-project' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const shared = getSharedDeps();
      const prompt = shared.prompt;

      const projects = await listProjects();
      if (projects.length === 0) {
        setPhase({ kind: 'no-projects' });
        return;
      }

      let projectName: string;
      if (preselectedProject) {
        // Router passed a project — skip the picker. If the project no longer
        // exists, fall through to the pipeline, which surfaces a clear
        // ProjectNotFoundError from load-project.
        projectName = preselectedProject;
      } else {
        setPhase({ kind: 'running', step: 'select-project' });
        projectName = await prompt.select<string>({
          message: 'Select a project to onboard:',
          choices: projects.map((p) => ({
            label: `${p.displayName} (${p.name})`,
            value: p.name,
            description: `${String(p.repositories.length)} repo${p.repositories.length === 1 ? '' : 's'}`,
          })),
        });
      }

      setPhase({ kind: 'running', step: 'onboarding' });
      const options: OnboardOptions = preselectedRepo ? { repo: preselectedRepo } : {};
      const pipeline = createOnboardPipeline(shared, options);
      const initialContext: OnboardContext = { sprintId: '', projectName };
      const result = await executePipeline(pipeline, initialContext);

      if (!result.ok) {
        setPhase({ kind: 'error', message: result.error.message });
        return;
      }
      const ctx = result.value.context;
      const agentsMd = ctx.agentsMdFinal ?? ctx.agentsMdDraft ?? '';
      setPhase({
        kind: 'done',
        projectName,
        writtenPath: ctx.writtenPath,
        checkScript: ctx.checkScriptFinal ?? null,
        driftWarnings: ctx.driftWarnings ?? [],
        lowConfidence: agentsMd.includes('LOW-CONFIDENCE:'),
        alreadyCurrent: ctx.alreadyCurrent,
      });
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
      return <ResultCard kind="error" title="Onboarding failed" lines={[phase.message]} />;
    case 'done': {
      const fields: [string, string][] = [['Project', phase.projectName]];
      if (phase.writtenPath) fields.push(['Project context file', phase.writtenPath]);
      if (phase.checkScript) fields.push(['Check script', phase.checkScript]);
      if (phase.driftWarnings && phase.driftWarnings.length > 0) {
        fields.push(['Warnings', phase.driftWarnings.join('; ')]);
      }
      if (phase.lowConfidence) {
        fields.push(['Review', 'Low-confidence sections present — re-run interactively to tighten']);
      }
      if (phase.alreadyCurrent) {
        return <ResultCard kind="info" title="Already current" fields={fields} />;
      }
      const nextSteps = phase.lowConfidence
        ? [{ action: 'Open the project context file and replace LOW-CONFIDENCE lines with concrete facts.' }]
        : undefined;
      return <ResultCard kind="success" title="Repository onboarded" fields={fields} nextSteps={nextSteps} />;
    }
  }
}

function stepLabel(step: 'select-project' | 'onboarding'): string {
  if (step === 'select-project') return 'Awaiting project selection…';
  // The pipeline drives its own prompts via getPrompt() (project context file editor +
  // check-script input); when a prompt is live, <PromptHost /> takes over the
  // screen and this spinner is hidden — so a generic "reviewing" label is
  // accurate for both the AI call and the review hand-off.
  return 'Inventorying repository and reviewing proposal…';
}
