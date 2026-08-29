/**
 * Settings seeding for `ralphctl demo` — the half of the sandbox that decides which AI CLI the
 * demo will actually talk to.
 *
 * The demo used to write {@link DEFAULT_SETTINGS} verbatim. Those defaults deliberately SPLIT the
 * implement roles across two providers (claude-code generator / openai-codex evaluator), so the
 * sandbox's headline "ready to implement" sprint failed the launch preflight unless BOTH CLIs were
 * installed — on a command whose whole promise is zero setup. This module probes PATH instead and
 * stamps a single-provider preset, mirroring the first-run welcome view.
 *
 * Difference from welcome, and the reason this isn't just a shared helper: welcome falls back to
 * the `mixed` (best-of-breed, cross-provider) preset for the zero-CLI and 2+-CLI cases. The demo
 * cannot — `mixed` is exactly the multi-CLI preflight that broke it. Here more than one detected
 * CLI resolves through {@link DEMO_PROVIDER_PREFERENCE} to ONE of them, and zero detected CLIs
 * falls back to `claude-only`: nothing is runnable either way, so the pick only has to be
 * deterministic and browsable (project / sprint / task views need no CLI at all).
 *
 * `ralphctl demo --script` overwrites what this writes — see `scripted-run.ts`, which pins every
 * row to claude-code because the canned transcript emulates that one CLI's stream format.
 */

import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applyPreset, type PresetName } from '@src/business/settings/presets.ts';
import { storagePathsFromRoot } from '@src/application/bootstrap/storage-paths.ts';
import { createJsonSettingsRepository } from '@src/integration/persistence/settings/json-settings-repository.ts';
import { detectInstalledProviders } from '@src/integration/system/detect-cli.ts';

export interface SeedDemoSettingsInput {
  /** Sandbox app root — the same `homeDir` handed to `seedDemoWorkspace`. */
  readonly homeDir: AbsolutePath;
  /** PATH probe. Tests stub it; production omits it and gets the real detector. */
  readonly detect?: () => Promise<ReadonlySet<AiProvider>>;
}

export interface SeededDemoSettings {
  /** The preset that was stamped — reported in the CLI summary so the pick isn't invisible. */
  readonly preset: PresetName;
  /** Whether PATH carried no supported CLI at all (the preset is then a placeholder). */
  readonly noCliDetected: boolean;
}

const PRESET_FOR_PROVIDER: Readonly<Record<AiProvider, PresetName>> = {
  'claude-code': 'claude-only',
  'github-copilot': 'copilot-only',
  'openai-codex': 'codex-only',
  opencode: 'opencode-only',
  'xai-grok': 'grok-only',
};

/**
 * Tie-break order when PATH carries more than one supported CLI, and the fallback when it carries
 * none. First hit wins, so the seeded sandbox is reproducible on a given machine.
 */
const DEMO_PROVIDER_PREFERENCE: readonly AiProvider[] = [
  'claude-code',
  'openai-codex',
  'github-copilot',
  'opencode',
  'xai-grok',
];

/** Pick the single-provider preset the demo sandbox runs under. */
const pickDemoPreset = (installed: ReadonlySet<AiProvider>): PresetName => {
  const chosen = DEMO_PROVIDER_PREFERENCE.find((provider) => installed.has(provider)) ?? 'claude-code';
  return PRESET_FOR_PROVIDER[chosen];
};

/**
 * Probe PATH, stamp the matching single-provider preset onto {@link DEFAULT_SETTINGS} and persist
 * it into the sandbox. Writing a settings file is also what keeps the sandbox from opening on the
 * first-run welcome flow.
 *
 * Only the AI section is preset-driven — harness / logging / concurrency / ui stay at the shipped
 * defaults, so the demo still shows the product's real behaviour.
 *
 * @public
 */
export const seedDemoSettings = async (
  input: SeedDemoSettingsInput
): Promise<Result<SeededDemoSettings, DomainError>> => {
  const paths = storagePathsFromRoot(input.homeDir);
  if (!paths.ok) return Result.error(paths.error);

  const installed = await (input.detect ?? detectInstalledProviders)();
  const preset = pickDemoPreset(installed);
  const settings = applyPreset(preset, DEFAULT_SETTINGS);

  const saved = await createJsonSettingsRepository({ configRoot: paths.value.configRoot }).save(settings);
  if (!saved.ok) return Result.error(saved.error);

  return Result.ok({ preset, settings, noCliDetected: installed.size === 0 });
};
