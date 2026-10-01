/**
 * First-run welcome. Probes PATH for the supported CLIs, seeds a preset (one CLI → `<provider>-only`,
 * zero or 2+ → `mixed`) unless settings already exist on disk, then holds on an orientation card
 * until a key is pressed. Held states: orientation (≥ 1 CLI, no project yet), the zero-CLI warning
 * and the seed-failed error; `esc` is claimed locally in all of them. With a project already on
 * disk the view routes straight to Work.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { ActionMenu, type MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { StageLegend } from '@src/application/ui/tui/components/sprint-pipeline.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';
import { detectInstalledProviders, PROVIDER_BINARY } from '@src/integration/system/detect-cli.ts';
import type { PresetName } from '@src/business/settings/presets.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';

type Step = 'detecting' | 'seeded' | 'error';

const PRESET_FOR_PROVIDER: Readonly<Record<AiProvider, PresetName>> = {
  'claude-code': 'claude-only',
  'github-copilot': 'copilot-only',
  'openai-codex': 'codex-only',
  opencode: 'opencode-only',
  'xai-grok': 'grok-only',
};

const ZERO_CLI_HINT = `${glyphs.warningGlyph} No AI CLIs detected — install one (claude / copilot / codex / opencode / grok) and run doctor.`;

const pickPresetForDetected = (installed: ReadonlySet<AiProvider>): PresetName => {
  if (installed.size === 1) {
    const [only] = [...installed];
    return PRESET_FOR_PROVIDER[only!];
  }
  return 'mixed';
};

/** Create-project when no project exists yet, else Work. */
const resolveNextRoute = async (projectRepo: ProjectRepository): Promise<ViewEntry> => {
  const projects = await projectRepo.list();
  const needsProject = projects.ok && projects.value.length === 0;
  return { id: needsProject ? 'create-project' : 'home' };
};

interface UseWelcomeSeedingResult {
  readonly step: Step;
  readonly chosenPreset: PresetName | undefined;
  readonly noCliDetected: boolean;
  readonly detected: readonly AiProvider[];
  readonly errorMsg: string | undefined;
  /** Set only on the zero-CLI branch — non-`undefined` means the keypress gate is up. */
  readonly pendingRoute: ViewEntry | undefined;
  readonly continueToPendingRoute: () => void;
}

const useWelcomeSeeding = (): UseWelcomeSeedingResult => {
  const deps = useDeps();
  const router = useRouter();
  const claimEscape = useUiState().claimEscape;
  const [step, setStep] = useState<Step>('detecting');
  const [chosenPreset, setChosenPreset] = useState<PresetName | undefined>(undefined);
  // Zero CLIs means the `mixed` seed is a placeholder, not a fit.
  const [noCliDetected, setNoCliDetected] = useState(false);
  const [detected, setDetected] = useState<readonly AiProvider[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);
  // Set while a held state waits for a key; routing is deferred until then.
  const [pendingRoute, setPendingRoute] = useState<ViewEntry | undefined>(undefined);
  // Seed once per instance; the `settingsRepo.exists()` check is the durable half across re-mounts.
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const seed = async (): Promise<void> => {
      // Durable idempotence gate. A settings file on disk means first-run setup already
      // happened, so re-seeding would replace the whole `ai` section (that is what
      // `applyPreset` does) over whatever the user configured in Settings since. Route onward
      // without probing PATH or writing anything. A storage error fails OPEN — a first run must
      // never be blocked by an unreadable settings probe.
      const already = await deps.settingsRepo.exists();
      if (already.ok && already.value) {
        router.reset(await resolveNextRoute(deps.projectRepo));
        return;
      }
      const installed = await detectInstalledProviders();
      const zeroCliDetected = installed.size === 0;
      setNoCliDetected(zeroCliDetected);
      setDetected([...installed]);
      const preset = pickPresetForDetected(installed);
      const flow = createSettingsApplyPresetFlow({ settingsRepo: deps.settingsRepo });
      const result = await flow.execute({ input: { preset } });
      if (!result.ok) {
        // Arms the escape hatch the error card advertises.
        setPendingRoute({ id: 'home' });
        setErrorMsg(result.error.error.message);
        setStep('error');
        return;
      }
      setChosenPreset(preset);
      setStep('seeded');
      const next = await resolveNextRoute(deps.projectRepo);
      if (zeroCliDetected || next.id === 'create-project') {
        setPendingRoute(next);
        return;
      }
      router.reset(next);
    };
    void seed();
  }, [deps, router]);

  const continueToPendingRoute = useCallback(() => {
    if (pendingRoute !== undefined) router.reset(pendingRoute);
  }, [pendingRoute, router]);

  // Claim esc so the global pop doesn't race the local continue.
  useEffect(() => (pendingRoute !== undefined ? claimEscape() : undefined), [pendingRoute, claimEscape]);

  return { step, chosenPreset, noCliDetected, detected, errorMsg, pendingRoute, continueToPendingRoute };
};

const CLOSING_LINE = 'After setup: 1–5 switch sections · S switches sprint · ? shows every key';

const providerList = (detected: readonly AiProvider[]): string => detected.map((p) => PROVIDER_BINARY[p]).join(', ');

interface OrientationProps {
  readonly detected: readonly AiProvider[];
  readonly preset: PresetName;
  readonly onCreate: () => void;
}

const Orientation = ({ detected, preset, onCreate }: OrientationProps): React.JSX.Element => {
  const ui = useUiState();
  const [showDemo, setShowDemo] = useState(false);
  const items: readonly MenuItem[] = [
    { id: 'create', label: 'Create a project', onSelect: onCreate },
    {
      id: 'demo',
      label: 'Try the demo sandbox',
      note: 'ralphctl demo',
      onSelect: () => setShowDemo(true),
    },
    { id: 'help', label: '? keyboard help', onSelect: ui.toggleHelp },
  ];
  return (
    <Box flexDirection="column">
      <Card title="How ralphctl works" tone="primary">
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            Detected <Text bold>{providerList(detected)}</Text>
            <Text dimColor>
              {' '}
              {glyphs.bullet} seeded the {preset} preset based on detected CLIs
            </Text>
          </Text>
          <Box marginTop={spacing.section}>
            <StageLegend />
          </Box>
        </Box>
      </Card>
      <Box marginTop={spacing.section} flexDirection="column">
        <ActionMenu items={items} />
        {showDemo && (
          <Box paddingX={spacing.indent}>
            <Text dimColor>The sandbox runs outside this session: quit, then run `ralphctl demo` in your shell.</Text>
          </Box>
        )}
      </Box>
      <Box marginTop={spacing.section} paddingX={spacing.indent}>
        <Text dimColor italic>
          {CLOSING_LINE}
        </Text>
      </Box>
    </Box>
  );
};

export const WelcomeView = (): React.JSX.Element => {
  const { step, chosenPreset, noCliDetected, detected, errorMsg, pendingRoute, continueToPendingRoute } =
    useWelcomeSeeding();
  const orientation = step === 'seeded' && !noCliDetected && pendingRoute !== undefined && chosenPreset !== undefined;

  const held = pendingRoute !== undefined;
  useViewKeys(
    [
      { keys: ['↵'], hint: 'continue', enabled: held && !orientation, run: continueToPendingRoute },
      { keys: ['↑', '↓'], hint: 'move', enabled: orientation },
      { keys: ['↵'], hint: 'select', enabled: orientation },
    ],
    { active: held }
  );

  useInput(
    (_input, key) => {
      if (key.escape) continueToPendingRoute();
    },
    { isActive: pendingRoute !== undefined }
  );

  if (orientation) {
    return (
      <ViewShell title="Welcome to ralphctl" subtitle="first-run setup">
        <Orientation detected={detected} preset={chosenPreset} onCreate={continueToPendingRoute} />
      </ViewShell>
    );
  }

  return (
    <ViewShell title="Welcome to ralphctl" subtitle="first-run setup">
      <Box flexDirection="column">
        <Card title="Seeding settings" tone={step === 'error' ? 'error' : 'primary'}>
          <Box flexDirection="column" paddingX={spacing.indent}>
            {step === 'detecting' && <Spinner label="probing PATH for installed AI CLIs…" />}
            {step === 'seeded' && chosenPreset !== undefined && (
              <Box flexDirection="column">
                <Text color={inkColors.warning}>{ZERO_CLI_HINT}</Text>
                <Text dimColor>Seeded the {chosenPreset} preset as a placeholder.</Text>
                <Text dimColor italic>
                  Press ↵ to continue.
                </Text>
              </Box>
            )}
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
