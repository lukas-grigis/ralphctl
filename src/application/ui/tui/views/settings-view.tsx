/**
 * Settings view — read + write surface. Navigation is field-by-field: ↑/↓ moves the cursor
 * through editable fields, Enter mounts the prompt appropriate to the field's type
 * (`SelectPrompt` for enums, `TextPrompt` for numbers/strings). Most routes funnel through
 * `applySettingsKey` (validation) → `settingsSet` use-case (persistence) so the TUI and the
 * `ralphctl settings set` CLI share a single mutation grammar.
 *
 * AI configuration is per-flow. Each row shows three editable fields — provider (enum), model
 * (provider catalog + a `+ custom` affordance for off-catalog ids), and effort
 * (provider-native levels, or `Default` to clear). A global `effort` row supplies a default
 * when a per-flow row leaves its `effort` unset. Switching a row's provider routes through
 * `settings-set-provider` (which rebuilds that row's `{ provider, model }` from the new
 * provider's defaults so the persistence schema stays satisfied).
 *
 * Storage paths remain read-only — they reflect the resolved runtime root rather than a
 * mutable setting.
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
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';
import type { LogLevel } from '@src/domain/value/log-level.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';

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
       * Model picker — a select prompt with a "+ custom" affordance that, when chosen, swaps
       * to a TextPrompt for a free-form model id. Used only by the per-flow model rows.
       */
      readonly kind: 'model';
      readonly key: string;
      readonly label: string;
      readonly options: readonly string[];
      readonly current: string;
    }
  | {
      /**
       * Preset button — activating it opens a confirmation prompt and (on yes) stamps the
       * preset onto the settings record via the apply-preset flow. The preset action group
       * renders as four equal buttons above the global effort row; no preset is marked as
       * "recommended" or "default".
       */
      readonly kind: 'preset';
      readonly key: string;
      readonly label: string;
      readonly preset: PresetName;
      readonly current: string;
    };

const PRESET_LABEL: Readonly<Record<PresetName, string>> = {
  mixed: 'Apply: Mixed',
  'claude-only': 'Apply: Claude only',
  'copilot-only': 'Apply: Copilot only',
  'codex-only': 'Apply: Codex only',
};

const LOG_LEVELS = ['silent', 'debug', 'info', 'warn', 'error'] as const;

const DEFAULT_TOKEN = 'Default' as const;
const CUSTOM_TOKEN = '+ custom' as const;

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

const buildEditableFields = (s: Settings): readonly EditableField[] => {
  const fields: EditableField[] = [];

  for (const preset of PRESET_NAMES) {
    fields.push({
      kind: 'preset',
      key: `presets.${preset}`,
      label: PRESET_LABEL[preset],
      preset,
      current: '↵ apply',
    });
  }

  fields.push({
    kind: 'select',
    key: 'ai.effort',
    label: 'Global effort',
    options: [DEFAULT_TOKEN, ...GLOBAL_EFFORT_LEVELS],
    current: s.ai.effort ?? DEFAULT_TOKEN,
  });

  for (const flow of FLOW_IDS) {
    const row = s.ai[flow];
    fields.push({
      kind: 'select',
      key: `ai.${flow}.provider`,
      label: `${capitalize(flow)} provider`,
      options: AI_PROVIDERS,
      current: row.provider,
    });
    fields.push({
      kind: 'model',
      key: `ai.${flow}.model`,
      label: `${capitalize(flow)} model`,
      options: [...modelOptionsFor(row.provider), CUSTOM_TOKEN],
      current: row.model,
    });
    fields.push({
      kind: 'select',
      key: `ai.${flow}.effort`,
      label: `${capitalize(flow)} effort`,
      options: [DEFAULT_TOKEN, ...PROVIDER_EFFORT_LEVELS[row.provider]],
      current: row.effort ?? DEFAULT_TOKEN,
    });
  }

  fields.push(
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
    { kind: 'select', key: 'logging.level', label: 'Log level', options: LOG_LEVELS, current: s.logging.level },
    {
      kind: 'text',
      key: 'concurrency.maxParallelTasks',
      label: 'Concurrency',
      current: String(s.concurrency.maxParallelTasks),
    }
  );

  return fields;
};

const capitalize = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

export const SettingsView = (): React.JSX.Element => {
  const deps = useDeps();
  const storage = useStorage();
  const ui = useUiState();
  const logLevel = useLogLevel();
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const [editingField, setEditingField] = useState<EditableField | undefined>(undefined);
  /** Holds a model field when the user picked "+ custom" — the editor swaps to a TextPrompt. */
  const [customModelField, setCustomModelField] = useState<EditableField | undefined>(undefined);
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

  const fields = useMemo<readonly EditableField[]>(
    () => (settings === undefined ? [] : buildEditableFields(settings)),
    [settings]
  );

  // Clamp cursor when the field set changes (e.g. provider switch resets model + effort).
  useEffect(() => {
    if (cursor >= fields.length && fields.length > 0) setCursor(fields.length - 1);
  }, [fields, cursor]);

  useInput((input, key) => {
    if (ui.helpOpen || editingField !== undefined || pendingPreset !== undefined || ui.promptActive) return;
    if (fields.length === 0) return;
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(fields.length - 1, c + 1));
      return;
    }
    if (key.return || input === 'e') {
      const field = fields[cursor];
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
  useEffect(
    () =>
      editingField !== undefined || customModelField !== undefined || pendingPreset !== undefined
        ? ui.claimPrompt()
        : undefined,
    [editingField, customModelField, pendingPreset, ui.claimPrompt]
  );

  const closeEditor = (): void => {
    setEditingField(undefined);
    setCustomModelField(undefined);
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
    // discriminated union satisfied.
    const providerMatch = /^ai\.(refine|plan|implement|readiness|ideate)\.provider$/.exec(field.key);
    if (providerMatch !== null) {
      const flow = providerMatch[1] as FlowId;
      const providerFlow = createSettingsSetProviderFlow({ settingsRepo: deps.settingsRepo });
      const saved = await providerFlow.execute({ input: { flow, provider: raw as AiProvider } });
      if (!saved.ok) {
        setFeedback({ tone: 'error', text: saved.error.error.message });
        closeEditor();
        return;
      }
      setFeedback({ tone: 'ok', text: `${capitalize(flow)} provider = ${raw} · model reset to default` });
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

  const renderEditor = (field: EditableField): React.JSX.Element => {
    if (field.kind === 'model' && customModelField !== undefined) {
      return (
        <TextPrompt
          message={`${field.label} (custom id, current: ${field.current})`}
          initial={field.current}
          onSubmit={(value) => void submit(value, field)}
          onCancel={closeEditor}
        />
      );
    }
    if (field.kind === 'select' || field.kind === 'model') {
      return (
        <SelectPrompt
          message={`${field.label} (current: ${field.current})`}
          options={field.options.map((value) => ({ label: value, value }))}
          onSubmit={(value) => {
            if (field.kind === 'model' && String(value) === CUSTOM_TOKEN) {
              setCustomModelField(field);
              return;
            }
            void submit(String(value), field);
          }}
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
    const focused = fields[cursor]?.key === key;
    const field = fields.find((f) => f.key === key);
    const value = field?.current ?? '';
    return (
      <Text {...(focused ? { color: inkColors.primary } : {})} bold={focused}>
        {focused ? `${glyphs.actionCursor} ` : '  '}
        {value}
      </Text>
    );
  };

  return (
    <ViewShell title="Settings" subtitle="↑/↓ navigate · ↵ edit · esc cancel">
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
      ) : settings === undefined ? (
        <Box paddingX={spacing.indent}>
          <Text dimColor>Loading…</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Card title="Presets" tone="primary">
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
          <Box marginTop={spacing.section}>
            <Card title="AI — global" tone="primary">
              <FieldList fields={[{ label: 'Effort (default)', value: valueFor('ai.effort') }]} />
            </Card>
          </Box>
          {FLOW_IDS.map((flow) => (
            <Box key={flow} marginTop={spacing.section}>
              <Card title={`AI — ${capitalize(flow)}`} tone="primary">
                <FieldList
                  fields={[
                    { label: 'Provider', value: valueFor(`ai.${flow}.provider`) },
                    { label: 'Model', value: valueFor(`ai.${flow}.model`) },
                    { label: 'Effort', value: valueFor(`ai.${flow}.effort`) },
                  ]}
                />
              </Card>
            </Box>
          ))}
          <Box marginTop={spacing.section}>
            <Card title="Harness budgets" tone="primary">
              <FieldList
                fields={[
                  {
                    label: 'Max turns',
                    value: valueFor('harness.maxTurns'),
                    hint: 'Cap on gen/eval iterations inside ONE task attempt — generator → evaluator → repeat.',
                  },
                  {
                    label: 'Max attempts',
                    value: valueFor('harness.maxAttempts'),
                    hint: 'How many times a single task may be re-attempted across separate Implement runs before it blocks.',
                  },
                  {
                    label: 'Rate-limit retries',
                    value: valueFor('harness.rateLimitRetries'),
                    hint: 'Auto-retries with exponential backoff when the AI provider returns a rate-limit error.',
                  },
                  {
                    label: 'Plateau threshold',
                    value: valueFor('harness.plateauThreshold'),
                    hint: 'Consecutive evaluator turns on the same failed dimensions before the loop exits (2-5).',
                  },
                ]}
              />
            </Card>
          </Box>
          <Box marginTop={spacing.section}>
            <Card title="Other" tone="primary">
              <FieldList
                fields={[
                  { label: 'Log level', value: valueFor('logging.level') },
                  { label: 'Concurrency', value: valueFor('concurrency.maxParallelTasks') },
                ]}
              />
            </Card>
          </Box>
          <Box marginTop={spacing.section}>
            <Card title="Storage paths" tone="rule">
              <FieldList
                fields={[
                  { label: 'App root', value: <Text dimColor>{storage.appRoot}</Text> },
                  { label: 'Data root', value: <Text dimColor>{storage.dataRoot}</Text> },
                  { label: 'Config root', value: <Text dimColor>{storage.configRoot}</Text> },
                ]}
              />
            </Card>
          </Box>
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
