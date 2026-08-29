/**
 * First-run welcome view. Shown once when no `settings.json` exists yet. On mount, probes PATH
 * for the supported CLIs (claude / copilot / codex / opencode / grok) and silently seeds a preset:
 *
 *   - exactly one CLI detected → `<provider>-only` preset
 *   - zero or 2+ CLIs detected → `mixed` preset (best-of-breed across providers)
 *
 * No manual provider picker is shown; the user can revisit Settings later to switch. After
 * seeding, the view shows a one-line summary naming which preset was applied and routes the
 * user straight to the create-project wizard (or home, if a project already exists).
 *
 * Zero-CLI keypress gate: when no AI CLI was detected, the destination route is held in state
 * instead of navigated to immediately — the auto-route used to fire in the same tick as the
 * warning render, so the user never actually got to read "No AI CLIs detected" before it
 * scrolled away. `↵` / space / `esc` all continue to the held destination; `esc` is claimed
 * locally (via `useUiState().claimEscape()`) so the global `router.pop()` handler doesn't also
 * fire and race the local continue. Every other branch (1 CLI, 2+ CLIs) still auto-routes.
 *
 * The seed-FAILED branch arms the same gate (destination `home`). It has to: the error card
 * names `esc`, Welcome is the router stack's root so the global `router.pop()` fall-through is a
 * no-op there, and an unarmed gate left the advertised key doing nothing.
 *
 * The welcome is read-only: an existing settings file means the user already set up readiness,
 * so the launch entry routes straight to home before this view ever mounts. The seeding effect
 * re-asserts that on DISK (`settingsRepo.exists()`) rather than trusting the launch decision —
 * a re-mounted view gets a fresh component instance (and so a fresh in-memory guard), and
 * re-seeding would replace the whole `ai` section over the user's own Settings edits.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';
import { detectInstalledProviders } from '@src/integration/system/detect-cli.ts';
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

/**
 * Where welcome hands the user off. After first-run setup the user still has no project, so walk
 * them straight into the create-project wizard rather than dropping them on a home screen they
 * can't use yet; a repo that already holds projects goes to home. Shared by the seeding path and
 * the already-seeded short-circuit so both land in the same place.
 */
const resolveNextRoute = async (projectRepo: ProjectRepository): Promise<ViewEntry> => {
  const projects = await projectRepo.list();
  const needsProject = projects.ok && projects.value.length === 0;
  return { id: needsProject ? 'create-project' : 'home' };
};

interface UseWelcomeSeedingResult {
  readonly step: Step;
  readonly chosenPreset: PresetName | undefined;
  readonly noCliDetected: boolean;
  readonly errorMsg: string | undefined;
  /** Set only on the zero-CLI branch — non-`undefined` means the keypress gate is up. */
  readonly pendingRoute: ViewEntry | undefined;
  readonly continueToPendingRoute: () => void;
}

/**
 * Runs the first-run PATH-detect → apply-preset → route sequence exactly once, and owns the
 * zero-CLI keypress gate (`pendingRoute` / `continueToPendingRoute`) plus the local `esc` claim
 * that keeps the global `router.pop()` handler from also firing while the gate is up.
 */
const useWelcomeSeeding = (): UseWelcomeSeedingResult => {
  const deps = useDeps();
  const router = useRouter();
  const claimEscape = useUiState().claimEscape;
  const [step, setStep] = useState<Step>('detecting');
  const [chosenPreset, setChosenPreset] = useState<PresetName | undefined>(undefined);
  // Track whether PATH had zero AI CLIs so the seeded copy doesn't claim a detection-based choice
  // when there was nothing to detect — the `mixed` fallback is a guess, not a fit.
  const [noCliDetected, setNoCliDetected] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);
  // Zero-CLI branch: hold the resolved destination here instead of routing immediately, so the
  // warning actually gets a chance to render before the user is carried away from it. Every
  // other branch routes as soon as seeding resolves, same as before.
  const [pendingRoute, setPendingRoute] = useState<ViewEntry | undefined>(undefined);
  // First-run seeding must execute exactly once, even if React re-runs the effect because a
  // parent re-render produced a fresh `deps` / `router` reference. Without this guard, the
  // apply-preset flow would fire on every re-render, writing settings multiple times. This ref
  // covers ONE component instance; the `settingsRepo.exists()` check below is the durable,
  // disk-backed half that also survives a re-mount.
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
      const preset = pickPresetForDetected(installed);
      const flow = createSettingsApplyPresetFlow({ settingsRepo: deps.settingsRepo });
      const result = await flow.execute({ input: { preset } });
      if (!result.ok) {
        // Hold `home` as the pending route BEFORE flipping to the error step. The error card
        // tells the user to press `esc`, and `pendingRoute` is what arms both the local escape
        // handler and the `claimEscape` that keeps the global `router.pop()` (a no-op at the
        // stack root) from racing it. Without it the advertised key does nothing at all.
        setPendingRoute({ id: 'home' });
        setErrorMsg(result.error.error.message);
        setStep('error');
        return;
      }
      setChosenPreset(preset);
      setStep('seeded');
      const next = await resolveNextRoute(deps.projectRepo);
      if (zeroCliDetected) {
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

  // Own `esc` locally while the gate is up so the global router.pop() handler stands down —
  // otherwise both handlers would fire on the same keystroke and race each other.
  useEffect(() => (pendingRoute !== undefined ? claimEscape() : undefined), [pendingRoute, claimEscape]);

  return { step, chosenPreset, noCliDetected, errorMsg, pendingRoute, continueToPendingRoute };
};

export const WelcomeView = (): React.JSX.Element => {
  const { step, chosenPreset, noCliDetected, errorMsg, pendingRoute, continueToPendingRoute } = useWelcomeSeeding();

  useViewKeys(
    [
      {
        // `↵` and space are the only keys distinguishable via `input` here — Ink reduces Escape
        // (and every arrow / fn / backspace key) to `input === ''`, so Escape is handled below
        // via `key.escape` instead of being folded into this dispatcher's matching.
        keys: ['\r', ' '],
        hint: 'continue',
        run: continueToPendingRoute,
      },
    ],
    { active: pendingRoute !== undefined }
  );

  useInput(
    (_input, key) => {
      if (key.escape) continueToPendingRoute();
    },
    { isActive: pendingRoute !== undefined }
  );

  return (
    <ViewShell title="Welcome to ralphctl" subtitle="first-run setup">
      <Box flexDirection="column">
        {/* One card wraps all three steps, so the tone is derived rather than a second card
            added — DESIGN-SYSTEM § 5 wants an error state on an `error`-toned surface. */}
        <Card title="Seeding settings" tone={step === 'error' ? 'error' : 'primary'}>
          <Box flexDirection="column" paddingX={spacing.indent}>
            {step === 'detecting' && <Spinner label="probing PATH for installed AI CLIs…" />}
            {step === 'seeded' &&
              chosenPreset !== undefined &&
              (noCliDetected ? (
                <Box flexDirection="column">
                  <Text color={inkColors.warning}>{ZERO_CLI_HINT}</Text>
                  <Text dimColor>Seeded the {chosenPreset} preset as a placeholder.</Text>
                  <Text dimColor italic>
                    Press ↵ to continue.
                  </Text>
                </Box>
              ) : (
                <Text>Seeded with {chosenPreset} preset based on detected CLIs.</Text>
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
