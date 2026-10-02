/**
 * Settings mutation orchestration — wraps the apply-key + set-provider + set + apply-preset flows behind a single
 * `submitField` entry point.
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
 * Provider-switch key shapes: implement carries a generator + evaluator pair addressed via a 4-segment key; every
 * other flow is the 3-segment shape.
 */
const IMPLEMENT_ROLE_PROVIDER_KEY = /^ai\.implement\.(generator|evaluator)\.provider$/;
const FLAT_PROVIDER_KEY = /^ai\.(refine|plan|readiness|ideate|createPr)\.provider$/;

/** Route: any per-flow / per-role provider picker. */
const setProvider = async (
  flow: FlowId,
  role: 'generator' | 'evaluator' | undefined,
  raw: string,
  settingsRepo: SettingsRepository
): Promise<MutationOutcome> => {
  const providerFlow = createSettingsSetProviderFlow({ settingsRepo });
  const saved = await providerFlow.execute({
    input: { flow, provider: raw as AiProvider, ...(role !== undefined ? { role } : {}) },
  });
  if (!saved.ok) return { kind: 'error', text: saved.error.error.message };
  const label = role !== undefined ? `Implement (${role})` : capitalize(flow);
  return { kind: 'ok', text: `${label} provider = ${raw} · model reset to default` };
};

/**
 * Route: the escalation-map "add a rung" action row — submits a `from=to` pair built by the two-step picker, reusing
 * the `harness.escalationMap.<from>` key the CLI's `settings set` speaks.
 */
const handleMapAddRoute = async (
  settings: Settings,
  raw: string,
  settingsRepo: SettingsRepository
): Promise<MutationOutcome> => {
  const pair = parseSettingsKvSyntax(raw);
  if (pair === undefined || pair.value.length === 0) {
    return { kind: 'error', text: `malformed escalation pair '${raw}' — expected <fromModel>=<toModel>` };
  }
  return persistKey(settings, `harness.escalationMap.${pair.key}`, pair.value, settingsRepo, {
    okText: `escalation rung added: ${pair.key} ${glyphs.arrowRight} ${pair.value}`,
  });
};

/**
 * Route: one editable escalation-map override row — an empty submitted value deletes it (the apply-key grammar's
 * clear semantic).
 */
const handleMapEntryRoute = async (
  settings: Settings,
  field: Extract<EditableField, { kind: 'map-entry' }>,
  raw: string,
  settingsRepo: SettingsRepository
): Promise<MutationOutcome> => {
  const okText =
    raw.trim().length === 0
      ? `removed escalation override for ${field.from}`
      : `escalation rung updated: ${field.from} ${glyphs.arrowRight} ${raw}`;
  return persistKey(settings, field.key, raw, settingsRepo, { okText });
};

/**
 * Fallback route: every other key through the generic `applySettingsKey` → `settings-set` pipeline. `Default` clears
 * effort overrides.
 */
const handleDefaultRoute = async (
  settings: Settings,
  field: EditableField,
  raw: string,
  settingsRepo: SettingsRepository
): Promise<MutationOutcome> => {
  const normalised = raw === DEFAULT_TOKEN ? '' : raw;
  return persistKey(settings, field.key, normalised, settingsRepo, { okText: `${field.label} = ${raw}` });
};

/** Persist a single field edit — provider keys first, then the escalation-map rows, then the generic fallback. */
export const submitField = async (
  settings: Settings,
  field: EditableField,
  raw: string,
  settingsRepo: SettingsRepository
): Promise<MutationOutcome> => {
  const role = IMPLEMENT_ROLE_PROVIDER_KEY.exec(field.key);
  if (role !== null) return setProvider('implement', role[1] as 'generator' | 'evaluator', raw, settingsRepo);
  const flat = FLAT_PROVIDER_KEY.exec(field.key);
  if (flat !== null) return setProvider(flat[1] as FlowId, undefined, raw, settingsRepo);
  if (field.kind === 'map-add') return handleMapAddRoute(settings, raw, settingsRepo);
  if (field.kind === 'map-entry') return handleMapEntryRoute(settings, field, raw, settingsRepo);
  return handleDefaultRoute(settings, field, raw, settingsRepo);
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

/** Apply a settings preset and return the warnings the apply-preset flow emitted. */
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
