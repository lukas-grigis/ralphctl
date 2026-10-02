/** Pure model layer for the Settings view — shared types + section builder. */

import { PRESET_NAMES, presetAiSettings, type PresetName } from '@src/business/settings/presets.ts';
import { mergeEscalationMap } from '@src/business/task/escalation-map.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { PresetWarning } from '@src/application/flows/settings-apply-preset/ctx.ts';
import type { AiFlowSettings, AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { AI_PROVIDERS as DOMAIN_AI_PROVIDERS } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';
import { isSuspendedModel, SUSPENSION_NOTE } from '@src/domain/value/settings-models/suspended-models.ts';
import { contextWindowLabel } from '@src/domain/value/settings-models/context-window.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';

/**
 * Provider options offered by the Settings view.
 * @public
 */
export const AI_PROVIDERS: readonly AiProvider[] = DOMAIN_AI_PROVIDERS;

export type EditableField =
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly options: readonly string[];
      readonly current: string;
    }
  | { readonly kind: 'text'; readonly key: string; readonly label: string; readonly current: string }
  | {
      /**
       * Preset button — activating it opens a confirmation prompt and (on yes) stamps the preset onto the settings
       * record via the apply-preset flow.
       */
      readonly kind: 'preset';
      readonly key: string;
      readonly label: string;
      readonly preset: PresetName;
      readonly current: string;
    }
  | {
      /** Escalation-map "add a rung" action row. */
      readonly kind: 'map-add';
      readonly key: string;
      readonly label: string;
      readonly current: string;
    }
  | {
      /** One editable escalation-map override (`harness.escalationMap.<from>`). */
      readonly kind: 'map-entry';
      readonly key: string;
      readonly label: string;
      readonly current: string;
      readonly from: string;
      readonly to: string;
    };

/** Top-level section identifier — drives the segmented strip and the per-section field list. */
export type SectionId =
  | 'presets'
  | 'global'
  | 'refine'
  | 'plan'
  | 'implement'
  | 'readiness'
  | 'ideate'
  | 'createPr'
  | 'harness'
  | 'other'
  | 'storage';

export interface SettingsSection {
  readonly id: SectionId;
  readonly label: string;
  readonly title: string;
  readonly fields: readonly EditableField[];
  /** `true` when the section carries no editable fields (just read-only display). */
  readonly readonly: boolean;
}

/** Row name inside its family group — the family heading carries the rest. */
export const PRESET_LABEL: Readonly<Record<PresetName, string>> = {
  mixed: 'Mixed',
  'claude-only': 'Claude',
  'copilot-only': 'Copilot',
  'codex-only': 'Codex',
  'opencode-only': 'OpenCode',
  'grok-only': 'Grok',
  'mixed-economic': 'Mixed',
  'claude-economic': 'Claude',
  'copilot-economic': 'Copilot',
  'codex-economic': 'Codex',
  'grok-economic': 'Grok',
  'mixed-strong-gate': 'Mixed',
  'claude-strong-gate': 'Claude',
  'copilot-strong-gate': 'Copilot',
  'codex-strong-gate': 'Codex',
  'grok-strong-gate': 'Grok',
  'mixed-fast': 'Mixed',
  'claude-fast': 'Claude',
  'copilot-fast': 'Copilot',
  'codex-fast': 'Codex',
  'grok-fast': 'Grok',
  'mixed-frontier': 'Mixed',
  'claude-frontier': 'Claude',
  'copilot-frontier': 'Copilot',
  'codex-frontier': 'Codex',
  'grok-frontier': 'Grok',
};

const modelAndEffort = (row: { readonly model: string; readonly effort?: string | undefined }): string =>
  row.effort === undefined ? row.model : `${row.model} ${row.effort}`;

/** One-line account of what a preset sets: the plan row and the implement generator, model and effort each. */
export const presetSummary = (preset: PresetName): string => {
  const ai = presetAiSettings(preset);
  return `plan ${modelAndEffort(ai.plan)} ${glyphs.bullet} implement ${modelAndEffort(ai.implement.generator)}`;
};

/** Display names for the five preset families — used by the grouped preset bar. */
export type PresetFamily = 'standard' | 'economic' | 'strong-gate' | 'fast' | 'frontier';

export const PRESET_FAMILY_LABEL: Readonly<Record<PresetFamily, string>> = {
  standard: 'Standard',
  economic: 'Economic',
  'strong-gate': 'Strong-gate',
  fast: 'Fast',
  frontier: 'Frontier',
};

/** Family shared by the five strong-gate presets. */
const STRONG_GATE: PresetFamily = 'strong-gate';

/** Maps each preset to its family — single source so preset-bar and any future caller stay in sync. */
export const PRESET_FAMILY: Readonly<Record<PresetName, PresetFamily>> = {
  mixed: 'standard',
  'claude-only': 'standard',
  'copilot-only': 'standard',
  'codex-only': 'standard',
  'opencode-only': 'standard',
  'grok-only': 'standard',
  'mixed-economic': 'economic',
  'claude-economic': 'economic',
  'copilot-economic': 'economic',
  'codex-economic': 'economic',
  'grok-economic': 'economic',
  'mixed-strong-gate': STRONG_GATE,
  'claude-strong-gate': STRONG_GATE,
  'copilot-strong-gate': STRONG_GATE,
  'codex-strong-gate': STRONG_GATE,
  'grok-strong-gate': STRONG_GATE,
  'mixed-fast': 'fast',
  'claude-fast': 'fast',
  'copilot-fast': 'fast',
  'codex-fast': 'fast',
  'grok-fast': 'fast',
  'mixed-frontier': 'frontier',
  'claude-frontier': 'frontier',
  'copilot-frontier': 'frontier',
  'codex-frontier': 'frontier',
  'grok-frontier': 'frontier',
};

export const LOG_LEVELS = ['silent', 'debug', 'info', 'warn', 'error'] as const;

export const DEFAULT_TOKEN = 'Default' as const;

const GLOBAL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const HARNESS_HINTS: Readonly<Record<string, string>> = {
  'harness.maxTurns': 'Cap on gen/eval iterations inside ONE task attempt — generator → evaluator → repeat.',
  'harness.maxAttempts':
    'How many times a single task may be re-attempted across separate Implement runs before it blocks.',
  'harness.rateLimitRetries': 'Auto-retries with exponential backoff when the AI provider returns a rate-limit error.',
  'harness.idleWatchdogMs':
    'Stdio-silence (ms) before a wedged AI child is killed — 60000-3600000, default 300000 (5 min). Raise for slow first-token models.',
  'harness.plateauThreshold': 'Consecutive evaluator turns on the same failed dimensions before the loop exits (2-5).',
  'harness.correctiveRetries':
    'Corrective nudges when the AI omits or malforms signals.json before the task blocks — 1-5, default 2. Each nudge is a full re-spawn.',
  'harness.escalateOnPlateau':
    'Gates ALL failure-driven escalation — plateau AND budget-exhausted exits climb the model ladder; disable to always stay on the configured model.',
  'harness.skipPreVerifyOnFreshSetup':
    'Asserts your setup script verifies the tree (builds + tests); enable only when setup is a full verify gate, not just a dependency install.',
  'harness.bestOfNCandidates':
    'Top-of-ladder remedy: 2-4 samples that many candidates on ONE granted attempt once the model ladder and the nudge are both spent (default 2); 0 disables it, as the economic presets do. That granted attempt spawns N generator sessions — costs more.',
  'harness.escalationMap':
    'Override or extend the built-in weaker → stronger ladder — pick the from-model, then the model it escalates to.',
};

/** Hint rendered under every escalation-map override row (keys are dynamic, so not in the map above). */
export const ESCALATION_ENTRY_HINT = 'Change the escalation target — pick (remove this override) to drop the rung.';

/**
 * Every provider's model catalog, in {@link AI_PROVIDERS} order — the catalog family pool the escalation pickers draw
 * from.
 */
const MODEL_CATALOGS: ReadonlyArray<readonly string[]> = AI_PROVIDERS.map((p) => PROVIDER_TRAITS[p].modelCatalog);

/** Union of every provider's model catalog — the FROM options for a new escalation rung. */
export const escalationModelOptions = (): readonly string[] => [...new Set<string>(MODEL_CATALOGS.flat())];

/**
 * Target options for an escalation rung starting at `from` — the union of the catalogs that list `from`, minus `from`
 * itself (a self-loop has no runtime effect and the schema-load path only warns).
 */
export const escalationTargetsFor = (from: string): readonly string[] => {
  const owning = MODEL_CATALOGS.filter((c) => c.includes(from));
  const pool = owning.length > 0 ? owning.flat() : MODEL_CATALOGS.flat();
  return [...new Set(pool)].filter((m) => m !== from);
};

export interface EscalationChain {
  /**
   * The generator provider whose ladder this chain belongs to, or `undefined` for a user-only chain rooted at a
   * custom id no catalog knows (it applies to whichever provider runs it).
   */
  readonly provider: AiProvider | undefined;
  /** Model ids in climb order, e.g. `['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5']`. */
  readonly models: readonly string[];
  /** True when any rung on the chain comes from the user's overrides (not the built-in map). */
  readonly customised: boolean;
}

/**
 * Walk every chain of `merged` whose root passes `isRoot` — a root is a model that is not itself an escalation
 * target.
 */
const chainsOf = (
  provider: AiProvider | undefined,
  merged: Readonly<Record<string, string>>,
  user: Readonly<Record<string, string>>,
  isRoot: (model: string) => boolean
): EscalationChain[] => {
  const targets = new Set(Object.values(merged));
  const chains: EscalationChain[] = [];
  for (const root of Object.keys(merged)) {
    if (targets.has(root) || !isRoot(root)) continue;
    const models: string[] = [root];
    const seen = new Set<string>([root]);
    let customised = root in user;
    let cur = merged[root];
    let prev = root;
    while (cur !== undefined && !seen.has(cur)) {
      if (user[prev] !== undefined) customised = true;
      models.push(cur);
      seen.add(cur);
      prev = cur;
      cur = merged[cur];
    }
    chains.push({ provider, models, customised });
  }
  return chains;
};

/**
 * The EFFECTIVE escalation ladders — the flat user overrides merged over each provider's built-in ladder — flattened
 * into display chains, grouped by provider in {@link AI_PROVIDERS} order.
 */
export const effectiveEscalationChains = (user: Readonly<Record<string, string>>): readonly EscalationChain[] => {
  const perProvider = AI_PROVIDERS.flatMap((provider) => {
    const catalog = new Set<string>(PROVIDER_TRAITS[provider].modelCatalog);
    return chainsOf(provider, mergeEscalationMap(user, provider), user, (m) => catalog.has(m));
  });
  const catalogued = new Set<string>(MODEL_CATALOGS.flat());
  const custom = chainsOf(undefined, mergeEscalationMap(user, undefined), user, (m) => !catalogued.has(m));
  return [...perProvider, ...custom];
};

/**
 * Full static model catalog for `provider` — delegates to {@link PROVIDER_TRAITS} so this file carries no copy of the
 * provider-to-catalog switch.
 */
export const modelOptionsFor = (provider: AiProvider): readonly string[] => PROVIDER_TRAITS[provider].modelCatalog;

/** Build the display label for a model picker option. */
export const annotateModelLabel = (model: string): string => {
  const windowPart = contextWindowLabel(model);
  const suspendedPart = isSuspendedModel(model) ? `(${SUSPENSION_NOTE})` : undefined;
  const annotations = [windowPart, suspendedPart].filter((s): s is string => s !== undefined);
  if (annotations.length === 0) return model;
  return `${model}  ${glyphs.bullet}  ${annotations.join('  ')}`;
};

export const capitalize = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

const FLOW_DISPLAY_LABEL: Partial<Record<FlowId, string>> = { createPr: 'Create-PR' };
const flowLabel = (flow: FlowId): string => FLOW_DISPLAY_LABEL[flow] ?? capitalize(flow);

const buildFlowFields = (
  keyPrefix: string,
  label: string,
  row: AiFlowSettings,
  availableModels: ReadonlyMap<AiProvider, readonly string[]> | undefined
): readonly EditableField[] => [
  {
    kind: 'select',
    key: `${keyPrefix}.provider`,
    label: `${label} provider`,
    options: AI_PROVIDERS,
    current: row.provider,
  },
  {
    kind: 'select',
    key: `${keyPrefix}.model`,
    label: `${label} model`,
    // Prefer the account-available subset for this provider when it has resolved; fall back to
    // the full catalog while the availability probe is still in flight (map empty/undefined).
    options: availableModels?.get(row.provider) ?? modelOptionsFor(row.provider),
    current: row.model,
  },
  {
    kind: 'select',
    key: `${keyPrefix}.effort`,
    label: `${label} effort`,
    options: [DEFAULT_TOKEN, ...PROVIDER_EFFORT_LEVELS[row.provider]],
    current: row.effort ?? DEFAULT_TOKEN,
  },
];

const buildPresetFields = (): readonly EditableField[] =>
  PRESET_NAMES.map((preset) => ({
    kind: 'preset' as const,
    key: `presets.${preset}`,
    label: PRESET_LABEL[preset],
    preset,
    current: presetSummary(preset),
  }));

const buildGlobalFields = (s: Settings): readonly EditableField[] => [
  {
    kind: 'select',
    key: 'ai.effort',
    label: 'Global effort',
    options: [DEFAULT_TOKEN, ...GLOBAL_EFFORT_LEVELS],
    current: s.ai.effort ?? DEFAULT_TOKEN,
  },
];

const buildImplementFields = (
  s: Settings,
  availableModels: ReadonlyMap<AiProvider, readonly string[]> | undefined
): readonly EditableField[] => [
  ...buildFlowFields('ai.implement.generator', 'Generator', s.ai.implement.generator, availableModels),
  ...buildFlowFields('ai.implement.evaluator', 'Evaluator', s.ai.implement.evaluator, availableModels),
];

const buildFlowSection = (
  s: Settings,
  flow: Exclude<FlowId, 'implement'>,
  availableModels: ReadonlyMap<AiProvider, readonly string[]> | undefined
): SettingsSection => ({
  id: flow,
  label: flowLabel(flow),
  title: `AI — ${flowLabel(flow)}`,
  fields: buildFlowFields(`ai.${flow}`, flowLabel(flow), s.ai[flow], availableModels),
  readonly: false,
});

/**
 * One editable row per escalation-map user override, directly under the add-row so the group reads as one unit.
 */
const buildEscalationOverrideFields = (escalationOverrides: ReadonlyArray<readonly [string, string]>) =>
  escalationOverrides.map(([from, to]): EditableField => ({
    kind: 'map-entry',
    key: `harness.escalationMap.${from}`,
    label: `  ${from}`,
    current: `${glyphs.arrowRight} ${to}`,
    from,
    to,
  }));

const buildHarnessFields = (s: Settings): readonly EditableField[] => {
  const escalationOverrides = Object.entries(s.harness.escalationMap);
  return [
    { kind: 'text', key: 'harness.maxTurns', label: 'Max turns', current: String(s.harness.maxTurns) },
    { kind: 'text', key: 'harness.maxAttempts', label: 'Max attempts', current: String(s.harness.maxAttempts) },
    {
      kind: 'text',
      key: 'harness.rateLimitRetries',
      label: 'Rate-limit retries',
      current: String(s.harness.rateLimitRetries),
    },
    {
      kind: 'text',
      key: 'harness.idleWatchdogMs',
      label: 'Idle watchdog (ms)',
      current: String(s.harness.idleWatchdogMs),
    },
    {
      kind: 'text',
      key: 'harness.plateauThreshold',
      label: 'Plateau threshold',
      current: String(s.harness.plateauThreshold),
    },
    {
      kind: 'text',
      key: 'harness.correctiveRetries',
      label: 'Corrective retries',
      current: String(s.harness.correctiveRetries),
    },
    {
      kind: 'select',
      key: 'harness.escalateOnPlateau',
      label: 'Escalate on plateau',
      options: ['true', 'false'],
      current: String(s.harness.escalateOnPlateau),
    },
    {
      kind: 'select',
      key: 'harness.skipPreVerifyOnFreshSetup',
      label: 'Skip pre-verify',
      options: ['true', 'false'],
      current: String(s.harness.skipPreVerifyOnFreshSetup),
    },
    {
      kind: 'text',
      key: 'harness.bestOfNCandidates',
      label: 'Best-of-N candidates',
      current: String(s.harness.bestOfNCandidates ?? 0),
    },
    {
      kind: 'map-add',
      key: 'harness.escalationMap',
      label: 'Escalation map',
      current:
        escalationOverrides.length === 0
          ? `defaults apply ${glyphs.bullet} ↵ add rung`
          : `${String(escalationOverrides.length)} override${escalationOverrides.length === 1 ? '' : 's'} ${glyphs.bullet} ↵ add rung`,
    },
    ...buildEscalationOverrideFields(escalationOverrides),
  ];
};

const buildOtherFields = (s: Settings): readonly EditableField[] => [
  { kind: 'select', key: 'logging.level', label: 'Log level', options: LOG_LEVELS, current: s.logging.level },
  {
    kind: 'text',
    key: 'concurrency.maxParallelTasks',
    label: 'Concurrency',
    current: String(s.concurrency.maxParallelTasks),
  },
];

export const buildSections = (
  s: Settings,
  availableModels?: ReadonlyMap<AiProvider, readonly string[]>
): readonly SettingsSection[] => [
  { id: 'presets', label: 'Presets', title: 'Presets', fields: buildPresetFields(), readonly: false },
  { id: 'global', label: 'Global', title: 'AI — global', fields: buildGlobalFields(s), readonly: false },
  buildFlowSection(s, 'refine', availableModels),
  buildFlowSection(s, 'plan', availableModels),
  {
    id: 'implement',
    label: 'Implement',
    title: 'AI — Implement',
    fields: buildImplementFields(s, availableModels),
    readonly: false,
  },
  buildFlowSection(s, 'readiness', availableModels),
  buildFlowSection(s, 'ideate', availableModels),
  buildFlowSection(s, 'createPr', availableModels),
  { id: 'harness', label: 'Harness', title: 'Harness budgets', fields: buildHarnessFields(s), readonly: false },
  { id: 'other', label: 'Other', title: 'Other', fields: buildOtherFields(s), readonly: false },
  { id: 'storage', label: 'Storage', title: 'Storage paths', fields: [], readonly: true },
];

/** `true` when `field` is a per-flow / per-role provider picker. */
export const isProviderField = (field: EditableField): boolean =>
  field.kind === 'select' && (field.key.endsWith('.provider') || field.key === 'ai.provider');

/** Setter bag {@link activateField} needs to open the right sub-view for a field's `kind`. */
export interface FieldActivationSetters {
  readonly setFeedback: (feedback: undefined) => void;
  readonly setPresetWarnings: (warnings: readonly PresetWarning[]) => void;
  readonly setPendingPreset: (preset: PresetName) => void;
  readonly setEditingField: (field: EditableField) => void;
}

/**
 * `↵/e` activation for the focused field — opens the preset-confirm prompt for a `preset` field, the field editor for
 * every other kind.
 */
export const activateField = (field: EditableField, setters: FieldActivationSetters): void => {
  setters.setFeedback(undefined);
  if (field.kind === 'preset') {
    setters.setPresetWarnings([]);
    setters.setPendingPreset(field.preset);
    return;
  }
  setters.setPresetWarnings([]);
  setters.setEditingField(field);
};

/**
 * `true` when `field` is a per-flow / per-role model picker — its options are model ids, so the editor flags
 * temporarily-suspended entries.
 */
export const isModelField = (field: EditableField): boolean => field.kind === 'select' && field.key.endsWith('.model');
