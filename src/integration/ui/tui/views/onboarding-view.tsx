/**
 * OnboardingView — first-run wizard.
 *
 * Mounts when the three first-run conditions all hold (no projects, no
 * current sprint, no AI provider configured). Routed from `App` as the
 * initial stack entry in that case.
 *
 * Flow: welcome → offer to add a project → offer to pick AI provider →
 * done. Every step is skippable — defaults leave things unset so the user
 * can configure them later via settings or `Browse → Projects → Add`.
 *
 * "Add a project now?" delegates to the existing `ProjectAddView` via
 * `router.push` (reuse, not reimplementation). The onboarding run finishes
 * before pushing; the user then lands back on home after project-add pops.
 */

import React, { useMemo } from 'react';
import type { AiProvider } from '@src/domain/models.ts';
import { getPrompt } from '@src/integration/bootstrap.ts';
import { setAiProvider } from '@src/integration/persistence/config.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useWorkflow } from './workflows/use-workflow.ts';

const TITLE = 'Welcome' as const;

const HINTS_RUNNING = [{ key: 'Esc', action: 'skip' }] as const;
const HINTS_DONE = [
  { key: 'Enter', action: 'home' },
  { key: 'Esc', action: 'home' },
] as const;

type Phase =
  | { kind: 'running'; step: 'intro' | 'project' | 'provider' | 'saving' }
  | { kind: 'done'; provider: AiProvider | null; addingProject: boolean }
  | { kind: 'error'; message: string };

const RUNNING_LABEL: Record<Extract<Phase, { kind: 'running' }>['step'], string> = {
  intro: 'Awaiting start…',
  project: 'Awaiting project choice…',
  provider: 'Awaiting provider choice…',
  saving: 'Saving…',
};

export function OnboardingView(): React.JSX.Element {
  const router = useRouter();

  const { phase } = useWorkflow<Phase>({
    initial: { kind: 'running', step: 'intro' },
    onError: (message) => ({ kind: 'error', message }),
    run: async ({ setPhase }) => {
      const prompt = getPrompt();

      setPhase({ kind: 'running', step: 'intro' });
      await prompt.confirm({
        message: 'ralphctl orchestrates AI coding agents across your repos. Ready to set up?',
        default: true,
      });

      setPhase({ kind: 'running', step: 'project' });
      const addProject = await prompt.confirm({
        message: 'Register a project now? (needed before you can create a sprint)',
        default: true,
      });

      setPhase({ kind: 'running', step: 'provider' });
      const provider = await prompt.select<AiProvider | 'skip'>({
        message: 'Pick an AI provider (you can change this later in settings):',
        choices: [
          { label: 'Claude Code', value: 'claude' },
          { label: 'GitHub Copilot', value: 'copilot' },
          { label: 'Skip for now', value: 'skip' },
        ],
      });

      if (provider !== 'skip') {
        setPhase({ kind: 'running', step: 'saving' });
        await setAiProvider(provider);
      }

      const picked: AiProvider | null = provider === 'skip' ? null : provider;
      setPhase({ kind: 'done', provider: picked, addingProject: addProject });

      if (addProject) {
        // Hand off to the existing project-add flow. Once the user finishes
        // (or cancels) there, they'll land back on whatever is underneath —
        // which is the onboarding done screen; Enter from there pops home.
        router.push({ id: 'project-add' });
      }
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
  if (phase.kind === 'error') {
    return <ResultCard kind="error" title="Onboarding failed" lines={[phase.message]} />;
  }
  const providerLabel =
    phase.provider === 'claude' ? 'Claude Code' : phase.provider === 'copilot' ? 'GitHub Copilot' : 'Skipped';
  const nextSteps = phase.addingProject
    ? [{ action: 'Finish adding your project', description: 'continuing to the project wizard…' }]
    : [
        { action: 'Register a project', description: 'Browse → Projects → Add' },
        { action: 'Create a sprint', description: 'once a project exists' },
      ];
  return (
    <ResultCard kind="success" title="You're set up" fields={[['AI provider', providerLabel]]} nextSteps={nextSteps} />
  );
}
