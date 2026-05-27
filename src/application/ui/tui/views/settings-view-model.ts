/**
 * Pure model layer for the Settings view — shared types + section builder. Lives next to the
 * view files so the orchestrator (`settings-view.tsx`) and the row renderers (`preset-bar.tsx`,
 * `ai-row.tsx`, `harness-row.tsx`) all consume the same section vocabulary without circular
 * imports. No JSX in this file by design.
 */

import { PRESET_NAMES, type PresetName } from '@src/business/settings/presets.ts';
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
};

export const LOG_LEVELS = ['silent', 'debug', 'info', 'warn', 'error'] as const;

export const DEFAULT_TOKEN = 'Default' as const;

const GLOBAL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const HARNESS_HINTS: Readonly<Record<string, string>> = {
  'harness.maxTurns': 'Cap on gen/eval iterations inside ONE task attempt — generator → evaluator → repeat.',
  'harness.maxAttempts':
    'How many times a single task may be re-attempted across separate Implement runs before it blocks.',
  'harness.rateLimitRetries': 'Auto-retries with exponential backoff when the AI provider returns a rate-limit error.',
  'harness.plateauThreshold': 'Consecutive evaluator turns on the same failed dimensions before the loop exits (2-5).',
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

const buildFlowFields = (keyPrefix: string, label: string, row: AiFlowSettings): readonly EditableField[] => [
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
    options: modelOptionsFor(row.provider),
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

export const buildSections = (s: Settings): readonly SettingsSection[] => {
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
    ...buildFlowFields('ai.implement.generator', 'Generator', s.ai.implement.generator),
    ...buildFlowFields('ai.implement.evaluator', 'Evaluator', s.ai.implement.evaluator),
  ];

  const flowSection = (flow: Exclude<FlowId, 'implement'>): SettingsSection => ({
    id: flow,
    label: flowLabel(flow),
    title: `AI — ${flowLabel(flow)}`,
    fields: buildFlowFields(`ai.${flow}`, flowLabel(flow), s.ai[flow]),
    readonly: false,
  });

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
      key: 'harness.plateauThreshold',
      label: 'Plateau threshold',
      current: String(s.harness.plateauThreshold),
    },
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
