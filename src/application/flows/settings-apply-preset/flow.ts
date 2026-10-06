import { Result } from '@src/domain/result.ts';
import { type AiProvider, type AiSettings, primaryFlowRow } from '@src/domain/entity/settings.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { applyPreset } from '@src/business/settings/presets.ts';
import { adaptAiToAvailableModels } from '@src/business/settings/adapt-to-available-models.ts';
import { detectInstalledProviders as defaultDetect } from '@src/integration/system/detect-cli.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';

import type {
  PresetWarning,
  SettingsApplyPresetCtx,
  SettingsApplyPresetInput,
  SettingsApplyPresetOutput,
} from '@src/application/flows/settings-apply-preset/ctx.ts';
import type { SettingsApplyPresetDeps } from '@src/application/flows/settings-apply-preset/deps.ts';

/**
 * Stamp a preset onto the current Settings. Loads the current record, replaces the AI
 * section with the preset's matrix (preserving harness / logging / concurrency / ui /
 * developer verbatim), and persists. No preset identity is stored — a subsequent edit to
 * any per-flow row sticks across reloads.
 *
 * After persistence succeeds, probe PATH for the binaries of every provider stamped into the
 * settings. Each provider configured but not detected becomes one entry in `output.warnings`
 * naming the affected flows. Persistence still succeeds — warnings are advisory only.
 *
 * Before saving, every row whose model the signed-in account can't run (per
 * `deps.availableModelsFor`) moves to its nearest available stand-in — see
 * `adaptAiToAvailableModels`. Without the dep, or when a probe can't answer, rows stay as stamped.
 *
 * The CLI's `settings apply-preset` subcommand and the TUI's preset buttons both route
 * through this flow. Schema validation runs at the persistence boundary, so a malformed
 * preset (out-of-catalog model) would surface as a `ParseError` rather than landing on
 * disk; in practice the four shipped presets are statically valid.
 */
export const createSettingsApplyPresetFlow = (deps: SettingsApplyPresetDeps): Element<SettingsApplyPresetCtx> =>
  leaf<SettingsApplyPresetCtx, SettingsApplyPresetInput, SettingsApplyPresetOutput>('settings-apply-preset', {
    useCase: {
      async execute(input) {
        const current = await deps.settingsRepo.load();
        if (!current.ok) return Result.error(current.error);
        const stamped = applyPreset(input.preset, current.value);
        const adapted = adaptAiToAvailableModels(stamped.ai, await probeAvailability(stamped.ai, deps));
        const next = { ...stamped, ai: adapted.ai };
        const saved = await deps.settingsRepo.save(next);
        if (!saved.ok) return Result.error(saved.error);
        const detect = deps.detectInstalledProviders ?? defaultDetect;
        const installed = await detect();
        const warnings = buildWarnings(next.ai, installed);
        return Result.ok({
          settings: next,
          warnings,
          substitutions: adapted.substitutions,
          unavailable: adapted.unavailable,
        });
      },
    },
    input: (c) => c.input,
    output: (c, o) => ({ ...c, output: o }),
    label: 'Apply preset',
  });

/** Live model lists for every provider the preset stamped; empty without the probe dep. */
const probeAvailability = async (
  ai: AiSettings,
  deps: SettingsApplyPresetDeps
): Promise<ReadonlyMap<AiProvider, ReadonlySet<string>>> => {
  const probe = deps.availableModelsFor;
  if (probe === undefined) return new Map();
  const providers = [...new Set(FLOW_IDS.flatMap((flow) => providersForFlow(ai, flow)))];
  const lists = await Promise.all(providers.map(async (p) => [p, new Set(await probe(p))] as const));
  return new Map(lists);
};

/**
 * Group missing-CLI flows by provider so the surface can show "codex missing — affects refine"
 * instead of "codex missing for refine; codex missing for plan; …". Flows preserve `FLOW_IDS`
 * order so output is stable across runs. For `implement` both roles' providers drive the
 * warning — `mixed` / `mixed-frontier` stamp a cross-provider generator/evaluator pair, so the
 * evaluator's CLI can be missing while the generator's is installed.
 */
const buildWarnings = (ai: AiSettings, installed: ReadonlySet<AiProvider>): readonly PresetWarning[] => {
  const byProvider = new Map<AiProvider, FlowId[]>();
  for (const flow of FLOW_IDS) {
    for (const provider of providersForFlow(ai, flow)) {
      if (installed.has(provider)) continue;
      const existing = byProvider.get(provider);
      if (existing) existing.push(flow);
      else byProvider.set(provider, [flow]);
    }
  }
  return [...byProvider.entries()].map(([provider, flows]) => ({ provider, flows }));
};

/** Implement contributes both role providers (deduped); every other flow has one row. */
const providersForFlow = (ai: AiSettings, flow: FlowId): readonly AiProvider[] => {
  const primary = primaryFlowRow(ai, flow).provider;
  if (flow !== 'implement') return [primary];
  const evaluator = ai.implement.evaluator.provider;
  return evaluator === primary ? [primary] : [primary, evaluator];
};
