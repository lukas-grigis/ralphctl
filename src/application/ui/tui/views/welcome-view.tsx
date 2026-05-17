/**
 * First-run welcome view. Shown once when no `settings.json` exists yet. Asks the user to pick
 * an AI provider, persists `DEFAULT_SETTINGS` keyed to that provider via the `settings-set`
 * use-case, then transitions to home. The welcome is read-only: an existing settings file
 * means the user already set up readiness — the launch entry routes straight to home in that case.
 */

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { SelectPrompt } from '@src/application/ui/tui/prompts/select-prompt.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { spacing, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import { DEFAULT_AI_SETTINGS_BY_PROVIDER, DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Choice } from '@src/business/interactive/prompt.ts';

type Step = 'pick-provider' | 'saving' | 'error';

const PROVIDER_CHOICES: ReadonlyArray<Choice<AiProvider>> = [
  { value: 'claude-code', label: 'Claude Code', description: 'Anthropic Claude (`claude` CLI)' },
  { value: 'github-copilot', label: 'GitHub Copilot', description: 'GitHub Copilot CLI (`copilot`)' },
  { value: 'openai-codex', label: 'OpenAI Codex', description: 'OpenAI Codex CLI (`codex`)' },
];

export const WelcomeView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const [step, setStep] = useState<Step>('pick-provider');
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);

  // Mark the prompt as active so the global keybindings (s/n/!/x for navigation) don't fight
  // the SelectPrompt's arrow handling. The release fn is returned directly so React's effect
  // cleanup matches each claim 1:1.
  React.useEffect(() => (step === 'pick-provider' ? ui.claimPrompt() : undefined), [step, ui.claimPrompt]);

  const onProviderPicked = async (raw: unknown): Promise<void> => {
    const provider = raw as AiProvider;
    setStep('saving');
    const next = { ...DEFAULT_SETTINGS, ai: DEFAULT_AI_SETTINGS_BY_PROVIDER[provider] };
    const setFlow = createSettingsSetFlow({ settingsRepo: deps.settingsRepo });
    const result = await setFlow.execute({ input: { next } });
    if (!result.ok) {
      setErrorMsg(result.error.error.message);
      setStep('error');
      return;
    }
    // After welcome, the user still has no project. Walk them straight into the create-project
    // wizard rather than dropping them on a home screen they can't actually use yet.
    const projects = await deps.projectRepo.list();
    const needsProject = projects.ok && projects.value.length === 0;
    router.reset({ id: needsProject ? 'create-project' : 'home' });
  };

  return (
    <ViewShell title="Welcome to ralphctl" subtitle="first-run setup">
      <Box flexDirection="column">
        <Card title="Pick an AI provider" tone="primary">
          <Box flexDirection="column" paddingX={spacing.indent}>
            <Text>
              ralphctl orchestrates your work through one of these CLIs. Pick the one you have installed and
              authenticated — you can change this later via Settings.
            </Text>
            <Box marginTop={spacing.section}>
              {step === 'pick-provider' && (
                <SelectPrompt
                  message="Provider"
                  options={PROVIDER_CHOICES as ReadonlyArray<Choice<unknown>>}
                  onSubmit={(value) => void onProviderPicked(value)}
                  onCancel={() => router.reset({ id: 'home' })}
                />
              )}
              {step === 'saving' && <Spinner label="saving settings…" />}
              {step === 'error' && (
                <Box flexDirection="column">
                  <Text color={inkColors.error}>Failed to save settings: {errorMsg}</Text>
                  <Text dimColor>Press esc to skip welcome and go to home.</Text>
                </Box>
              )}
            </Box>
          </Box>
        </Card>
        <Box marginTop={spacing.section} paddingX={spacing.indent}>
          <Text dimColor italic>
            After welcome you can run `ralphctl doctor` (or press `!`) to check that the chosen provider's CLI is
            installed and your storage is reachable.
          </Text>
        </Box>
      </Box>
    </ViewShell>
  );
};
