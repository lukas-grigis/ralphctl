/**
 * Pure model layer for the Settings view — shared types + section builder. Lives next to the
 * view files so the orchestrator (`settings-view.tsx`) and the row renderers (`preset-bar.tsx`,
 * `ai-row.tsx`, `harness-row.tsx`) all consume the same section vocabulary without circular
 * imports. No JSX in this file by design.
 */

import { PRESET_NAMES, type PresetName } from '@src/business/settings/presets.ts';
import { mergeEscalationMap } from '@src/business/task/escalation-map.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { AiFlowSettings, AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';

export const AI_PROVIDERS: readonly AiProvider[] = ['claude-code', 'github-copilot', 'openai-codex'];

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
       * Preset button — activating it opens a confirmation prompt and (on yes) stamps the
       * preset onto the settings record via the apply-preset flow. The preset action group
       * renders as four equal buttons; no preset is marked as "recommended" or "default".
       */
      readonly kind: 'preset';
      readonly key: string;
      readonly label: string;
      readonly preset: PresetName;
      readonly current: string;
    }
  | {
      /**
       * Escalation-map "add a rung" action row. Activating it (↵/e) walks a two-step picker —
       * choose the FROM model, then the model it escalates TO — and submits the pair as
       * `from=to`; `submitField` translates that to the `harness.escalationMap.<from>` key the
       * CLI grammar already speaks.
       */
      readonly kind: 'map-add';
      readonly key: string;
      readonly label: string;
      readonly current: string;
    }
  | {
      /**
       * One editable escalation-map override (`harness.escalationMap.<from>`). Activating it
       * opens a target picker pre-scoped to catalogs containing `from`, plus a
       * `(remove this override)` choice that submits the empty string — the apply-key grammar's
       * delete semantic.
       */
      readonly kind: 'map-entry';
      readonly key: string;
      readonly label: string;
      readonly current: string;
      readonly from: string;
      readonly to: string;
    };

/**
 * Top-level section identifier — drives the segmented strip and the per-section field list.
 * Sections are picked so no one section exceeds the ~8-row cursor cap; Implement (six rows —
 * generator + evaluator triples) is the largest.
 */
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

export const PRESET_LABEL: Readonly<Record<PresetName, string>> = {
  mixed: 'Apply: Mixed',
  'claude-only': 'Apply: Claude only',
  'copilot-only': 'Apply: Copilot only',
  'codex-only': 'Apply: Codex only',
  'mixed-economic': 'Apply: Mixed (economic)',
  'claude-economic': 'Apply: Claude (economic)',
  'copilot-economic': 'Apply: Copilot (economic)',
  'codex-economic': 'Apply: Codex (economic)',
  'mixed-strong-gate': 'Apply: Mixed strong-gate',
  'claude-strong-gate': 'Apply: Claude strong-gate',
  'copilot-strong-gate': 'Apply: Copilot strong-gate',
  'codex-strong-gate': 'Apply: Codex strong-gate',
  'mixed-fast': 'Apply: Mixed (fast)',
  'claude-fast': 'Apply: Claude (fast)',
  'copilot-fast': 'Apply: Copilot (fast)',
  'codex-fast': 'Apply: Codex (fast)',
  'mixed-frontier': 'Apply: Mixed (frontier)',
  'claude-frontier': 'Apply: Claude (frontier)',
  'copilot-frontier': 'Apply: Copilot (frontier)',
  'codex-frontier': 'Apply: Codex (frontier)',
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

/** Maps each preset to its family — single source so preset-bar and any future caller stay in sync. */
export const PRESET_FAMILY: Readonly<Record<PresetName, PresetFamily>> = {
  mixed: 'standard',
  'claude-only': 'standard',
  'copilot-only': 'standard',
  'codex-only': 'standard',
  'mixed-economic': 'economic',
  'claude-economic': 'economic',
  'copilot-economic': 'economic',
  'codex-economic': 'economic',
  'mixed-strong-gate': 'strong-gate',
  'claude-strong-gate': 'strong-gate',
  'copilot-strong-gate': 'strong-gate',
  'codex-strong-gate': 'strong-gate',
  'mixed-fast': 'fast',
  'claude-fast': 'fast',
  'copilot-fast': 'fast',
  'codex-fast': 'fast',
  'mixed-frontier': 'frontier',
  'claude-frontier': 'frontier',
  'copilot-frontier': 'frontier',
  'codex-frontier': 'frontier',
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
  'harness.escalateOnPlateau':
    'Gates ALL failure-driven escalation — plateau AND budget-exhausted exits climb the model ladder; disable to always stay on the configured model.',
  'harness.skipPreVerifyOnFreshSetup':
    'Asserts your setup script verifies the tree (builds + tests); enable only when setup is a full verify gate, not just a dependency install.',
  'harness.escalationMap':
    'Override or extend the built-in weaker → stronger ladder — pick the from-model, then the model it escalates to.',
};

/** Hint rendered under every escalation-map override row (keys are dynamic, so not in the map above). */
export const ESCALATION_ENTRY_HINT = 'Change the escalation target — pick (remove this override) to drop the rung.';

/**
 * Union of every provider's model catalog — the FROM options for a new escalation rung. Order:
 * Claude, Copilot, Codex; duplicates (ids shared across catalogs) collapse to their first
 * occurrence.
 */
export const escalationModelOptions = (): readonly string[] => [
  ...new Set<string>([...CLAUDE_MODELS, ...COPILOT_MODELS, ...CODEX_MODELS]),
];

/**
 * Target options for an escalation rung starting at `from` — the union of the catalogs that
 * list `from`, minus `from` itself (a self-loop has no runtime effect and the schema-load path
 * only warns). Scoping targets to the same catalog family keeps the picker from inviting
 * cross-provider ids the generator's CLI could never spawn. A `from` no catalog knows (a
 * custom id set via the CLI) falls back to the full union.
 */
export const escalationTargetsFor = (from: string): readonly string[] => {
  const catalogs: ReadonlyArray<readonly string[]> = [CLAUDE_MODELS, COPILOT_MODELS, CODEX_MODELS];
  const owning = catalogs.filter((c) => c.includes(from));
  const pool = owning.length > 0 ? owning.flat() : catalogs.flat();
  return [...new Set(pool)].filter((m) => m !== from);
};

export interface EscalationChain {
  /** Model ids in climb order, e.g. `['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8']`. */
  readonly models: readonly string[];
  /** True when any rung on the chain comes from the user's overrides (not the built-in map). */
  readonly customised: boolean;
}

/**
 * The EFFECTIVE escalation ladder — user overrides merged over the built-in map — flattened
 * into display chains. A chain starts at every model that is not itself an escalation target
 * (a root) and follows the map until it ends or would revisit a model (user-authored cycles
 * are cut rather than walked forever; the runtime treats cyclic rungs as top-of-ladder too).
 */
export const effectiveEscalationChains = (user: Readonly<Record<string, string>>): readonly EscalationChain[] => {
  const merged = mergeEscalationMap(user);
  const targets = new Set(Object.values(merged));
  const chains: EscalationChain[] = [];
  for (const root of Object.keys(merged)) {
    if (targets.has(root)) continue;
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
    chains.push({ models, customised });
  }
  return chains;
};

export const modelOptionsFor = (provider: AiProvider): readonly string[] => {
  switch (provider) {
    case 'claude-code':
      return CLAUDE_MODELS;
    case 'github-copilot':
      return COPILOT_MODELS;
    case 'openai-codex':
      return CODEX_MODELS;
  }
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

export const buildSections = (
  s: Settings,
  availableModels?: ReadonlyMap<AiProvider, readonly string[]>
): readonly SettingsSection[] => {
  const presetFields: readonly EditableField[] = PRESET_NAMES.map((preset) => ({
    kind: 'preset' as const,
    key: `presets.${preset}`,
    label: PRESET_LABEL[preset],
    preset,
    current: '↵ apply',
  }));

  const globalFields: readonly EditableField[] = [
    {
      kind: 'select',
      key: 'ai.effort',
      label: 'Global effort',
      options: [DEFAULT_TOKEN, ...GLOBAL_EFFORT_LEVELS],
      current: s.ai.effort ?? DEFAULT_TOKEN,
    },
  ];

  const implementFields: readonly EditableField[] = [
    ...buildFlowFields('ai.implement.generator', 'Generator', s.ai.implement.generator, availableModels),
    ...buildFlowFields('ai.implement.evaluator', 'Evaluator', s.ai.implement.evaluator, availableModels),
  ];

  const flowSection = (flow: Exclude<FlowId, 'implement'>): SettingsSection => ({
    id: flow,
    label: flowLabel(flow),
    title: `AI — ${flowLabel(flow)}`,
    fields: buildFlowFields(`ai.${flow}`, flowLabel(flow), s.ai[flow], availableModels),
    readonly: false,
  });

  const escalationOverrides = Object.entries(s.harness.escalationMap);
  const harnessFields: readonly EditableField[] = [
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
      kind: 'map-add',
      key: 'harness.escalationMap',
      label: 'Escalation map',
      current:
        escalationOverrides.length === 0
          ? `defaults apply ${glyphs.bullet} ↵ add rung`
          : `${String(escalationOverrides.length)} override${escalationOverrides.length === 1 ? '' : 's'} ${glyphs.bullet} ↵ add rung`,
    },
    // One editable row per user override, directly under the add-row so the group reads as one
    // unit. Keys reuse the CLI grammar (`harness.escalationMap.<from>`) — submit routes through
    // the same applySettingsKey path `settings set` uses.
    ...escalationOverrides.map(
      ([from, to]): EditableField => ({
        kind: 'map-entry',
        key: `harness.escalationMap.${from}`,
        label: `  ${from}`,
        current: `${glyphs.arrowRight} ${to}`,
        from,
        to,
      })
    ),
  ];

  const otherFields: readonly EditableField[] = [
    { kind: 'select', key: 'logging.level', label: 'Log level', options: LOG_LEVELS, current: s.logging.level },
    {
      kind: 'text',
      key: 'concurrency.maxParallelTasks',
      label: 'Concurrency',
      current: String(s.concurrency.maxParallelTasks),
    },
  ];

  return [
    { id: 'presets', label: 'Presets', title: 'Presets', fields: presetFields, readonly: false },
    { id: 'global', label: 'Global', title: 'AI — global', fields: globalFields, readonly: false },
    flowSection('refine'),
    flowSection('plan'),
    { id: 'implement', label: 'Implement', title: 'AI — Implement', fields: implementFields, readonly: false },
    flowSection('readiness'),
    flowSection('ideate'),
    flowSection('createPr'),
    { id: 'harness', label: 'Harness', title: 'Harness budgets', fields: harnessFields, readonly: false },
    { id: 'other', label: 'Other', title: 'Other', fields: otherFields, readonly: false },
    { id: 'storage', label: 'Storage', title: 'Storage paths', fields: [], readonly: true },
  ];
};

/**
 * `true` when `field` is a per-flow / per-role provider picker. Provider fields surface the
 * availability gate (dimmed unavailable rows, install-guidance footer); every other select
 * stays plain.
 */
export const isProviderField = (field: EditableField): boolean =>
  field.kind === 'select' && (field.key.endsWith('.provider') || field.key === 'ai.provider');

/**
 * `true` when `field` is a per-flow / per-role model picker — its options are model ids, so the
 * editor flags temporarily-suspended entries. The escalation FROM/TO pickers are separate field
 * kinds (`map-add` / `map-entry`), not `select`, so they are unaffected here.
 */
export const isModelField = (field: EditableField): boolean => field.kind === 'select' && field.key.endsWith('.model');
