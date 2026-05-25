/**
 * Settings view — read + write surface, organised into a tabbed section strip so the cursor
 * path within any one section stays bounded (≤ ~8 rows). `←/→` switch sections; `↑/↓` navigate
 * fields inside the active section; `↵/e` mounts the prompt appropriate to the field's type
 * (`SelectPrompt` for enums + model catalogs, `TextPrompt` for numbers / free-text strings).
 * Most routes funnel through `applySettingsKey` (validation) → `settingsSet` use-case
 * (persistence) so the TUI and the `ralphctl settings set` CLI share a single mutation
 * grammar.
 *
 * AI configuration is per-flow. Each flow renders as a dedicated section with three editable
 * rows — provider (enum), model (provider catalog only), and effort (provider-native levels,
 * or `Default` to clear). The Implement section carries six rows (generator + evaluator
 * triples) which still falls inside the per-section cap. A global `effort` row supplies a
 * default when a per-flow row leaves its `effort` unset. Switching a row's provider routes
 * through `settings-set-provider` (which rebuilds that row's `{ provider, model }` from the
 * new provider's defaults so the persistence schema stays satisfied).
 *
 * Off-catalog persisted model values stay visible on read — the model row renders whatever
 * `s.ai.<flow>.model` is. Only the editor surface is catalog-only: picking a catalog entry
 * overwrites the off-catalog string; until the user does so, the persisted value remains.
 *
 * Storage paths sit in their own read-only section so they don't compete with editable rows;
 * they reflect the resolved runtime root rather than a mutable setting.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { FieldList } from '@src/application/ui/tui/components/field-list.tsx';
import { TextPrompt } from '@src/application/ui/tui/prompts/text-prompt.tsx';
import { SelectPrompt } from '@src/application/ui/tui/prompts/select-prompt.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { useLogLevel } from '@src/application/ui/tui/runtime/log-level-context.tsx';
import { spacing, inkColors, glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { createSettingsShowFlow } from '@src/application/flows/settings-show/flow.ts';
import { createSettingsSetFlow } from '@src/application/flows/settings-set/flow.ts';
import { createSettingsSetProviderFlow } from '@src/application/flows/settings-set-provider/flow.ts';
import { createSettingsApplyPresetFlow } from '@src/application/flows/settings-apply-preset/flow.ts';
import { applySettingsKey } from '@src/business/settings/apply-key.ts';
import { PRESET_NAMES, type PresetName } from '@src/business/settings/presets.ts';
import type { PresetWarning } from '@src/application/flows/settings-apply-preset/ctx.ts';
import type { AiFlowSettings, AiProvider, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { LogLevel } from '@src/domain/value/log-level.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { detectInstalledProviders, primaryInstallCommand } from '@src/integration/system/detect-cli.ts';

const AI_PROVIDERS: readonly AiProvider[] = ['claude-code', 'github-copilot', 'openai-codex'];

type EditableField =
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
type SectionId =
  | 'presets'
  | 'global'
  | 'refine'
  | 'plan'
  | 'implement'
  | 'readiness'
  | 'ideate'
  | 'harness'
  | 'other'
  | 'storage';

interface SettingsSection {
  readonly id: SectionId;
  readonly label: string;
  readonly title: string;
  readonly fields: readonly EditableField[];
  /** `true` when the section carries no editable fields (just read-only display). */
  readonly readonly: boolean;
}

const PRESET_LABEL: Readonly<Record<PresetName, string>> = {
  mixed: 'Apply: Mixed',
  'claude-only': 'Apply: Claude only',
  'copilot-only': 'Apply: Copilot only',
  'codex-only': 'Apply: Codex only',
};

const LOG_LEVELS = ['silent', 'debug', 'info', 'warn', 'error'] as const;

const DEFAULT_TOKEN = 'Default' as const;

const PROVIDER_EFFORT_LEVELS: Readonly<Record<AiProvider, readonly string[]>> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  'github-copilot': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'openai-codex': ['minimal', 'low', 'medium', 'high'],
};

const GLOBAL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const modelOptionsFor = (provider: AiProvider): readonly string[] => {
  switch (provider) {
    case 'claude-code':
      return CLAUDE_MODELS;
    case 'github-copilot':
      return COPILOT_MODELS;
    case 'openai-codex':
      return CODEX_MODELS;
  }
};

const capitalize = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

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

const buildSections = (s: Settings): readonly SettingsSection[] => {
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
    label: capitalize(flow),
    title: `AI — ${capitalize(flow)}`,
    fields: buildFlowFields(`ai.${flow}`, capitalize(flow), s.ai[flow]),
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
    { id: 'harness', label: 'Harness', title: 'Harness budgets', fields: harnessFields, readonly: false },
    { id: 'other', label: 'Other', title: 'Other', fields: otherFields, readonly: false },
    { id: 'storage', label: 'Storage', title: 'Storage paths', fields: [], readonly: true },
  ];
};

const HARNESS_HINTS: Readonly<Record<string, string>> = {
  'harness.maxTurns': 'Cap on gen/eval iterations inside ONE task attempt — generator → evaluator → repeat.',
  'harness.maxAttempts':
    'How many times a single task may be re-attempted across separate Implement runs before it blocks.',
  'harness.rateLimitRetries': 'Auto-retries with exponential backoff when the AI provider returns a rate-limit error.',
  'harness.plateauThreshold': 'Consecutive evaluator turns on the same failed dimensions before the loop exits (2-5).',
};

export const SettingsView = (): React.JSX.Element => {
  const deps = useDeps();
  const storage = useStorage();
  const ui = useUiState();
  const logLevel = useLogLevel();
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  /**
   * Set of providers whose CLI binary resolved on PATH at mount time. Probed once per Settings
   * session — the per-row Settings editor never re-probes; the user has to leave and re-enter
   * Settings to refresh the gate (matches the apply-preset / launch-time probe sites). Stays
   * `undefined` while the probe is in flight; the provider picker treats `undefined` as "all
   * enabled" so the picker is usable in the rare frame between mount and probe-completion.
   */
  const [installedProviders, setInstalledProviders] = useState<ReadonlySet<AiProvider> | undefined>(undefined);
  const [sectionIdx, setSectionIdx] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [editingField, setEditingField] = useState<EditableField | undefined>(undefined);
  /** Pending preset confirmation — populated when the user activates a preset button. */
  const [pendingPreset, setPendingPreset] = useState<PresetName | undefined>(undefined);
  const [feedback, setFeedback] = useState<{ readonly tone: 'ok' | 'error'; readonly text: string } | undefined>(
    undefined
  );
  /**
   * Warnings from the most recent apply-preset. Rendered as a dimmed multi-line note below the
   * preset action group; cleared when the user activates a new preset or edits any other row.
   */
  const [presetWarnings, setPresetWarnings] = useState<readonly PresetWarning[]>([]);
  useViewHints([
    { keys: '←/→', label: 'section' },
    { keys: '↑/↓', label: 'navigate' },
    { keys: '↵/e', label: 'edit' },
  ]);

  const refresh = React.useCallback(async (): Promise<void> => {
    const flow = createSettingsShowFlow({ settingsRepo: deps.settingsRepo });
    const result = await flow.execute({ input: undefined });
    if (result.ok) setSettings(result.value.ctx.output!);
    else setLoadError(result.error.error.message);
  }, [deps]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void detectInstalledProviders().then((installed) => {
      if (!cancelled) setInstalledProviders(installed);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo<readonly SettingsSection[]>(
    () => (settings === undefined ? [] : buildSections(settings)),
    [settings]
  );

  const activeSection = sections[sectionIdx];
  const activeFields = activeSection?.fields ?? [];

  // Clamp cursor when the active section's field set changes (e.g. a provider switch resets
  // the model + effort options on the same section).
  useEffect(() => {
    if (cursor >= activeFields.length && activeFields.length > 0) setCursor(activeFields.length - 1);
  }, [activeFields, cursor]);

  // Clamp the section pointer if the section list ever shrinks below the current index.
  useEffect(() => {
    if (sectionIdx >= sections.length && sections.length > 0) setSectionIdx(sections.length - 1);
  }, [sections, sectionIdx]);

  useInput((input, key) => {
    if (ui.helpOpen || editingField !== undefined || pendingPreset !== undefined || ui.promptActive) return;
    if (sections.length === 0) return;
    if (key.leftArrow || input === '[') {
      setSectionIdx((i) => (i - 1 + sections.length) % sections.length);
      setCursor(0);
      setFeedback(undefined);
      return;
    }
    if (key.rightArrow || input === ']') {
      setSectionIdx((i) => (i + 1) % sections.length);
      setCursor(0);
      setFeedback(undefined);
      return;
    }
    if (activeFields.length === 0) return;
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(activeFields.length - 1, c + 1));
      return;
    }
    if (key.return || input === 'e') {
      const field = activeFields[cursor];
      if (field === undefined) return;
      setFeedback(undefined);
      if (field.kind === 'preset') {
        setPresetWarnings([]);
        setPendingPreset(field.preset);
        return;
      }
      setPresetWarnings([]);
      setEditingField(field);
    }
  });

  // Tie the prompt-active claim to the editing-field state so React's effect cleanup matches
  // the claim 1:1. Earlier we toggled imperatively from inside event handlers and the boolean
  // got clobbered by the PromptHost when its queue was empty.
  const claimPrompt = ui.claimPrompt;
  useEffect(
    () => (editingField !== undefined || pendingPreset !== undefined ? claimPrompt() : undefined),
    [editingField, pendingPreset, claimPrompt]
  );

  const closeEditor = (): void => {
    setEditingField(undefined);
  };

  const applyPreset = async (preset: PresetName): Promise<void> => {
    const flow = createSettingsApplyPresetFlow({ settingsRepo: deps.settingsRepo });
    const saved = await flow.execute({ input: { preset } });
    if (!saved.ok) {
      setFeedback({ tone: 'error', text: saved.error.error.message });
      return;
    }
    setFeedback({ tone: 'ok', text: `applied preset ${preset}` });
    setPresetWarnings(saved.value.ctx.output!.warnings);
    await refresh();
  };

  const submit = async (raw: string, field: EditableField): Promise<void> => {
    if (settings === undefined) {
      setFeedback({ tone: 'error', text: 'settings not loaded yet' });
      closeEditor();
      return;
    }
    // Per-flow provider switches route through `settings-set-provider` so the row's model
    // gets rebuilt from the target provider's defaults — keeps the schema's per-row
    // discriminated union satisfied. Implement carries a generator + evaluator pair and is
    // addressed via a 4-segment key; every other flow is the 3-segment shape.
    const implementRoleProviderMatch = /^ai\.implement\.(generator|evaluator)\.provider$/.exec(field.key);
    const flatProviderMatch = /^ai\.(refine|plan|readiness|ideate)\.provider$/.exec(field.key);
    if (implementRoleProviderMatch !== null || flatProviderMatch !== null) {
      const providerFlow = createSettingsSetProviderFlow({ settingsRepo: deps.settingsRepo });
      const flow: FlowId = implementRoleProviderMatch !== null ? 'implement' : (flatProviderMatch![1] as FlowId);
      const role = implementRoleProviderMatch?.[1] as 'generator' | 'evaluator' | undefined;
      const saved = await providerFlow.execute({
        input: { flow, provider: raw as AiProvider, ...(role !== undefined ? { role } : {}) },
      });
      if (!saved.ok) {
        setFeedback({ tone: 'error', text: saved.error.error.message });
        closeEditor();
        return;
      }
      const label = role !== undefined ? `Implement (${role})` : capitalize(flow);
      setFeedback({ tone: 'ok', text: `${label} provider = ${raw} · model reset to default` });
      closeEditor();
      await refresh();
      return;
    }
    // `Default` clears the value (per-flow effort + global effort both treat empty as unset).
    const normalised = raw === DEFAULT_TOKEN ? '' : raw;
    const next = applySettingsKey(settings, field.key, normalised);
    if (!next.ok) {
      setFeedback({ tone: 'error', text: next.error.message });
      closeEditor();
      return;
    }
    const setFlow = createSettingsSetFlow({ settingsRepo: deps.settingsRepo });
    const saved = await setFlow.execute({ input: { next: next.value } });
    if (!saved.ok) {
      setFeedback({ tone: 'error', text: saved.error.error.message });
      closeEditor();
      return;
    }
    if (field.key === 'logging.level') {
      logLevel.setLevel(next.value.logging.level satisfies LogLevel);
    }
    setFeedback({ tone: 'ok', text: `${field.label} = ${raw}` });
    closeEditor();
    await refresh();
  };

  /**
   * `true` when `field` is a per-flow / per-role provider picker. Provider fields surface the
   * availability gate (dimmed unavailable rows, install-guidance footer); every other select
   * stays plain.
   */
  const isProviderField = (field: EditableField): boolean =>
    field.kind === 'select' && (field.key.endsWith('.provider') || field.key === 'ai.provider');

  /**
   * Build the option list for a provider picker. Unavailable providers render `'(not installed)'`
   * suffixed and are marked `disabled` so SelectPrompt skips them on keyboard navigation and
   * refuses submission. When the availability probe has not completed yet, every option stays
   * enabled — the gate still fires server-side via the settings-set-provider flow.
   */
  const buildProviderOptions = (
    options: readonly string[]
  ): {
    readonly choices: ReadonlyArray<{ readonly label: string; readonly value: string; readonly disabled?: boolean }>;
    readonly footer?: string;
  } => {
    const installed = installedProviders;
    const choices = options.map((value) => {
      const provider = value as AiProvider;
      const available = installed === undefined || installed.has(provider);
      const label = available ? value : `${value} (not installed)`;
      return available ? { label, value } : { label, value, disabled: true };
    });
    const anyEnabled = choices.some((o) => o.disabled !== true);
    const missing = options.filter((v) => installed !== undefined && !installed.has(v as AiProvider));
    const footerParts: string[] = [];
    if (!anyEnabled) {
      footerParts.push('No AI provider CLI is installed.');
    }
    for (const m of missing) {
      footerParts.push(`install ${m}: ${primaryInstallCommand(m as AiProvider)}`);
    }
    if (footerParts.length === 0) return { choices };
    return { choices, footer: footerParts.join(' · ') };
  };

  const renderEditor = (field: EditableField): React.JSX.Element => {
    if (field.kind === 'select') {
      if (isProviderField(field)) {
        const { choices, footer } = buildProviderOptions(field.options);
        return (
          <SelectPrompt
            message={`${field.label} (current: ${field.current})`}
            options={choices}
            {...(footer !== undefined ? { footer } : {})}
            onSubmit={(value) => void submit(String(value), field)}
            onCancel={closeEditor}
          />
        );
      }
      return (
        <SelectPrompt
          message={`${field.label} (current: ${field.current})`}
          options={field.options.map((value) => ({ label: value, value }))}
          onSubmit={(value) => void submit(String(value), field)}
          onCancel={closeEditor}
        />
      );
    }
    return (
      <TextPrompt
        message={`${field.label} (current: ${field.current})`}
        initial={field.current}
        onSubmit={(value) => void submit(value, field)}
        onCancel={closeEditor}
      />
    );
  };

  const valueFor = (key: string): React.ReactNode => {
    if (settings === undefined) return null;
    const focused = activeFields[cursor]?.key === key;
    const field = activeFields.find((f) => f.key === key);
    const value = field?.current ?? '';
    return (
      <Text {...(focused ? { color: inkColors.primary } : {})} bold={focused}>
        {focused ? `${glyphs.actionCursor} ` : '  '}
        {value}
      </Text>
    );
  };

  const renderSectionStrip = (): React.JSX.Element => (
    <Box flexWrap="wrap">
      {sections.map((sec, i) => {
        const isActive = i === sectionIdx;
        return (
          <Box key={sec.id} marginRight={spacing.indent}>
            <Text {...(isActive ? { color: inkColors.primary } : { dimColor: true })} bold={isActive}>
              {isActive ? `${glyphs.actionCursor} ${sec.label}` : `  ${sec.label}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  const renderSectionBody = (section: SettingsSection): React.JSX.Element => {
    if (section.id === 'storage') {
      return (
        <Card title={section.title} tone="rule">
          <FieldList
            fields={[
              { label: 'App root', value: <Text dimColor>{storage.appRoot}</Text> },
              { label: 'Data root', value: <Text dimColor>{storage.dataRoot}</Text> },
              { label: 'Config root', value: <Text dimColor>{storage.configRoot}</Text> },
            ]}
          />
        </Card>
      );
    }
    if (section.id === 'presets') {
      return (
        <Card title={section.title} tone="primary">
          <FieldList
            fields={PRESET_NAMES.map((preset) => ({
              label: PRESET_LABEL[preset],
              value: valueFor(`presets.${preset}`),
            }))}
          />
          {presetWarnings.length > 0 && (
            <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
              {presetWarnings.map((w) => (
                <Text key={w.provider} dimColor>
                  ⚠ {w.provider} CLI not found on PATH; affects flows: {w.flows.join(', ')}
                </Text>
              ))}
            </Box>
          )}
        </Card>
      );
    }
    if (section.id === 'implement') {
      // Implement is the only flow whose runtime carries two AI sessions per task — the
      // generator that proposes a commit and the evaluator that judges it. Render the parent
      // section title once; the two roles render as indented sub-rows underneath so the
      // operator sees at a glance that they're two halves of the same flow rather than two
      // independent flows. Edits on either role flow through the same dotted-path keys
      // (`ai.implement.<role>.<field>`), so changing one role's provider/model/effort cannot
      // perturb the other.
      return (
        <Card title={section.title} tone="primary">
          {(['generator', 'evaluator'] as const).map((role, idx) => (
            <Box
              key={role}
              flexDirection="column"
              paddingLeft={spacing.indent}
              marginTop={idx === 0 ? 0 : spacing.section}
            >
              <Text dimColor bold>
                {role}
              </Text>
              <FieldList
                fields={[
                  { label: 'Provider', value: valueFor(`ai.implement.${role}.provider`) },
                  { label: 'Model', value: valueFor(`ai.implement.${role}.model`) },
                  { label: 'Effort', value: valueFor(`ai.implement.${role}.effort`) },
                ]}
              />
            </Box>
          ))}
        </Card>
      );
    }
    if (section.id === 'harness') {
      return (
        <Card title={section.title} tone="primary">
          <FieldList
            fields={section.fields.map((f) => {
              const hint = HARNESS_HINTS[f.key];
              return {
                label: f.label,
                value: valueFor(f.key),
                ...(hint !== undefined ? { hint } : {}),
              };
            })}
          />
        </Card>
      );
    }
    if (section.id === 'global') {
      return (
        <Card title={section.title} tone="primary">
          <FieldList fields={[{ label: 'Effort (default)', value: valueFor('ai.effort') }]} />
        </Card>
      );
    }
    if (section.id === 'other') {
      return (
        <Card title={section.title} tone="primary">
          <FieldList
            fields={[
              { label: 'Log level', value: valueFor('logging.level') },
              { label: 'Concurrency', value: valueFor('concurrency.maxParallelTasks') },
            ]}
          />
        </Card>
      );
    }
    // Per-flow section (refine / plan / readiness / ideate) — three editable rows.
    return (
      <Card title={section.title} tone="primary">
        <FieldList
          fields={[
            { label: 'Provider', value: valueFor(`ai.${section.id}.provider`) },
            { label: 'Model', value: valueFor(`ai.${section.id}.model`) },
            { label: 'Effort', value: valueFor(`ai.${section.id}.effort`) },
          ]}
        />
      </Card>
    );
  };

  return (
    <ViewShell title="Settings" subtitle="←/→ section · ↑/↓ navigate · ↵ edit · esc cancel">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : pendingPreset !== undefined ? (
        <ConfirmPrompt
          message={`Apply preset ${pendingPreset}? This overwrites all AI rows.`}
          defaultYes={false}
          onSubmit={(yes) => {
            const preset = pendingPreset;
            setPendingPreset(undefined);
            if (yes) void applyPreset(preset);
          }}
          onCancel={() => setPendingPreset(undefined)}
        />
      ) : editingField !== undefined ? (
        renderEditor(editingField)
      ) : loadError !== undefined ? (
        <Box paddingX={spacing.indent}>
          <Text color="red">Failed to load settings: {loadError}</Text>
        </Box>
      ) : settings === undefined || activeSection === undefined ? (
        <Box paddingX={spacing.indent}>
          <Text dimColor>Loading…</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {renderSectionStrip()}
          <Box marginTop={spacing.section}>{renderSectionBody(activeSection)}</Box>
          {feedback !== undefined && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Text color={feedback.tone === 'ok' ? inkColors.primary : 'red'}>
                {feedback.tone === 'ok' ? '✓' : '✗'} {feedback.text}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </ViewShell>
  );
};
