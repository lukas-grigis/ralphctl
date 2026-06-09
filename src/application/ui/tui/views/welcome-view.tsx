/**
 * First-run welcome view. Shown once when no `settings.json` exists yet. On mount, probes PATH
 * for the supported CLIs (claude / gh / codex) and silently seeds a preset:
 *
 *   - exactly one CLI detected → `<provider>-only` preset
 *   - zero or 2+ CLIs detected → `mixed` preset (best-of-breed across providers)
 *
 * No manual provider picker is shown; the user can revisit Settings later to switch. After
 * seeding, the view shows a one-line summary naming which preset was applied and routes the
 * user straight to the create-project wizard (or home, if a project already exists).
 *
 * The welcome is read-only: an existing settings file means the user already set up readiness,
 * so the launch entry routes straight to home before this view ever mounts.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';
import { detectInstalledProviders } from '@src/integration/system/detect-cli.ts';
import type { PresetName } from '@src/business/settings/presets.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';

type Step = 'detecting' | 'seeded' | 'error';

const PRESET_FOR_PROVIDER: Readonly<Record<AiProvider, PresetName>> = {
  'claude-code': 'claude-only',
  'github-copilot': 'copilot-only',
  'openai-codex': 'codex-only',
};

const PRESET_LABEL: Readonly<Record<PresetName, string>> = {
  mixed: 'mixed',
  'claude-only': 'claude-only',
  'copilot-only': 'copilot-only',
  'codex-only': 'codex-only',
  'mixed-economic': 'mixed-economic',
  'claude-economic': 'claude-economic',
  'copilot-economic': 'copilot-economic',
  'codex-economic': 'codex-economic',
};

const pickPresetForDetected = (installed: ReadonlySet<AiProvider>): PresetName => {
  if (installed.size === 1) {
    const [only] = [...installed];
    return PRESET_FOR_PROVIDER[only!];
  }
  return 'mixed';
};

export const WelcomeView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const [step, setStep] = useState<Step>('detecting');
  const [chosenPreset, setChosenPreset] = useState<PresetName | undefined>(undefined);
  // Track whether PATH had zero AI CLIs so the seeded copy doesn't claim a detection-based choice
  // when there was nothing to detect — the `mixed` fallback is a guess, not a fit.
  const [noCliDetected, setNoCliDetected] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);
  // First-run seeding must execute exactly once, even if React re-runs the effect because a
  // parent re-render produced a fresh `deps` / `router` reference. Without this guard, the
  // apply-preset flow would fire on every re-render, writing settings multiple times.
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const seed = async (): Promise<void> => {
      const installed = await detectInstalledProviders();
      setNoCliDetected(installed.size === 0);
      const preset = pickPresetForDetected(installed);
      const flow = createSettingsApplyPresetFlow({ settingsRepo: deps.settingsRepo });
      const result = await flow.execute({ input: { preset } });
      if (!result.ok) {
        setErrorMsg(result.error.error.message);
        setStep('error');
        return;
      }
      setChosenPreset(preset);
      setStep('seeded');
      // After welcome, the user still has no project. Walk them straight into the create-
      // project wizard rather than dropping them on a home screen they can't actually use yet.
      const projects = await deps.projectRepo.list();
      const needsProject = projects.ok && projects.value.length === 0;
      router.reset({ id: needsProject ? 'create-project' : 'home' });
    };
    void seed();
  }, [deps, router]);

  return (
    <ViewShell title="Welcome to ralphctl" subtitle="first-run setup">
      <Box flexDirection="column">
        <Card title="Seeding settings" tone="primary">
          <Box flexDirection="column" paddingX={spacing.indent}>
            {step === 'detecting' && <Spinner label="probing PATH for installed AI CLIs…" />}
            {step === 'seeded' &&
              chosenPreset !== undefined &&
              (noCliDetected ? (
                <Box flexDirection="column">
                  <Text color={inkColors.warning}>
                    {glyphs.warningGlyph} No AI CLIs detected — install one (claude / copilot / codex) and run doctor.
                  </Text>
                  <Text dimColor>Seeded the {PRESET_LABEL[chosenPreset]} preset as a placeholder.</Text>
                </Box>
              ) : (
                <Text>Seeded with {PRESET_LABEL[chosenPreset]} preset based on detected CLIs.</Text>
              ))}
            {step === 'error' && (
              <Box flexDirection="column">
                <Text color={inkColors.error}>Failed to save settings: {errorMsg}</Text>
                <Text dimColor>Press esc to skip welcome and go to home.</Text>
              </Box>
            )}
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
