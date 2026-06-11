/**
 * Settings mutation orchestration — wraps the apply-key + set-provider + set + apply-preset
 * flows behind a single `submitField` entry point. The TUI's SettingsView consumes this so the
 * orchestrator file stays focused on render + key handling.
 *
 * Every routing decision (`ai.implement.<role>.provider` vs `ai.<flow>.provider` vs everything
 * else) lives here; the view only forwards the raw submitted value + the editable field
 * descriptor.
 */

import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import { createSettingsSetProviderFlow } from '@src/application/flows/settings-set-provider/flow.ts';
import type { PresetWarning } from '@src/application/flows/settings-apply-preset/ctx.ts';
import { applySettingsKey, parseSettingsKvSyntax } from '@src/business/settings/apply-key.ts';
import type { PresetName } from '@src/business/settings/presets.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { capitalize, DEFAULT_TOKEN, type EditableField } from '@src/application/ui/tui/views/settings-view-model.ts';

export type MutationOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly next?: Settings }
  | { readonly kind: 'error'; readonly text: string };

export type PresetOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly warnings: readonly PresetWarning[] }
  | { readonly kind: 'error'; readonly text: string };

/**
 * Persist a single field edit. Routes provider switches through `settings-set-provider`
 * (rebuilds the row's model from the target provider's defaults) and every other key through
 * the generic `applySettingsKey` → `settings-set` pipeline. `Default` clears effort overrides.
 *
 * Returns a `MutationOutcome` rather than throwing so the view can render a feedback banner
 * without an additional try/catch wrapper. The `next` payload is the persisted record — the
 * view uses it to mirror per-key side effects (e.g. log-level sync) without re-reading from disk.
 */
export const submitField = async (
  settings: Settings,
  field: EditableField,
  raw: string,
  settingsRepo: SettingsRepository
): Promise<MutationOutcome> => {
  // Implement carries a generator + evaluator pair and is addressed via a 4-segment key;
  // every other flow is the 3-segment shape.
  const implementRoleProviderMatch = /^ai\.implement\.(generator|evaluator)\.provider$/.exec(field.key);
  const flatProviderMatch = /^ai\.(refine|plan|readiness|ideate|createPr)\.provider$/.exec(field.key);
  if (implementRoleProviderMatch !== null || flatProviderMatch !== null) {
    const providerFlow = createSettingsSetProviderFlow({ settingsRepo });
    const flow: FlowId = implementRoleProviderMatch !== null ? 'implement' : (flatProviderMatch![1] as FlowId);
    const role = implementRoleProviderMatch?.[1] as 'generator' | 'evaluator' | undefined;
    const saved = await providerFlow.execute({
      input: { flow, provider: raw as AiProvider, ...(role !== undefined ? { role } : {}) },
    });
    if (!saved.ok) return { kind: 'error', text: saved.error.error.message };
    const label = role !== undefined ? `Implement (${role})` : capitalize(flow);
    return { kind: 'ok', text: `${label} provider = ${raw} · model reset to default` };
  }
  // Escalation-map fields: the add-row submits a `from=to` pair (built by the two-step
  // picker); per-entry rows submit a bare target — empty string deletes (the apply-key
  // grammar's clear semantic). Both reuse the same `harness.escalationMap.<from>` key the
  // CLI's `settings set` speaks, so the mutation grammar stays one truth.
  if (field.kind === 'map-add') {
    const pair = parseSettingsKvSyntax(raw);
    if (pair === undefined || pair.value.length === 0) {
      return { kind: 'error', text: `malformed escalation pair '${raw}' — expected <fromModel>=<toModel>` };
    }
    return persistKey(settings, `harness.escalationMap.${pair.key}`, pair.value, settingsRepo, {
      okText: `escalation rung added: ${pair.key} ${glyphs.arrowRight} ${pair.value}`,
    });
  }
  if (field.kind === 'map-entry') {
    const okText =
      raw.trim().length === 0
        ? `removed escalation override for ${field.from}`
        : `escalation rung updated: ${field.from} ${glyphs.arrowRight} ${raw}`;
    return persistKey(settings, field.key, raw, settingsRepo, { okText });
  }
  const normalised = raw === DEFAULT_TOKEN ? '' : raw;
  return persistKey(settings, field.key, normalised, settingsRepo, { okText: `${field.label} = ${raw}` });
};

/** Shared applySettingsKey → settings-set tail used by every non-provider route above. */
const persistKey = async (
  settings: Settings,
  key: string,
  value: string,
  settingsRepo: SettingsRepository,
  opts: { readonly okText: string }
): Promise<MutationOutcome> => {
  const next = applySettingsKey(settings, key, value);
  if (!next.ok) return { kind: 'error', text: next.error.message };
  const setFlow = createSettingsSetFlow({ settingsRepo });
  const saved = await setFlow.execute({ input: { next: next.value } });
  if (!saved.ok) return { kind: 'error', text: saved.error.error.message };
  return { kind: 'ok', text: opts.okText, next: next.value };
};

/**
 * Apply a settings preset and return the warnings the apply-preset flow emitted. The view
 * renders those warnings underneath the preset bar until the next preset / row edit clears them.
 */
export const applyPreset = async (preset: PresetName, settingsRepo: SettingsRepository): Promise<PresetOutcome> => {
  const flow = createSettingsApplyPresetFlow({ settingsRepo });
  const saved = await flow.execute({ input: { preset } });
  if (!saved.ok) return { kind: 'error', text: saved.error.error.message };
  return {
    kind: 'ok',
    text: `applied preset ${preset}`,
    warnings: saved.value.ctx.output!.warnings,
  };
};
