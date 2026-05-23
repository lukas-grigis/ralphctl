/**
 * Settings view — read + write surface. Navigation is field-by-field: ↑/↓ moves the cursor
 * through editable fields, Enter mounts the prompt appropriate to the field's type
 * (`SelectPrompt` for enums, `TextPrompt` for numbers/strings). Most routes funnel through
 * `applySettingsKey` (validation) → `settingsSet` use-case (persistence) so the TUI and the
 * `ralphctl settings set` CLI share a single mutation grammar. The `ai.provider` field is
 * special-cased: it routes through `settingsSetProvider`, which atomically rebuilds the four
 * chain models from that provider's defaults (changing only `provider` would leave the models
 * incoherent with the schema's discriminated union and the save would reject).
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
import { applySettingsKey } from '@src/business/settings/apply-key.ts';
import type { AiProvider, Settings } from '@src/domain/entity/settings.ts';
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
  | { readonly kind: 'text'; readonly key: string; readonly label: string; readonly current: string };

const LOG_LEVELS = ['silent', 'debug', 'info', 'warn', 'error'] as const;

const modelOptionsFor = (provider: Settings['ai']['provider']): readonly string[] => {
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
  const models = modelOptionsFor(s.ai.provider);
  return [
    {
      kind: 'select',
      key: 'ai.provider',
      label: 'Provider',
      options: AI_PROVIDERS,
      current: s.ai.provider,
    },
    { kind: 'select', key: 'ai.models.refine', label: 'Refine model', options: models, current: s.ai.models.refine },
    { kind: 'select', key: 'ai.models.plan', label: 'Plan model', options: models, current: s.ai.models.plan },
    {
      kind: 'select',
      key: 'ai.models.ideate',
      label: 'Ideate model',
      options: models,
      current: s.ai.models.ideate,
    },
    {
      kind: 'select',
      key: 'ai.models.implement',
      label: 'Implement model',
      options: models,
      current: s.ai.models.implement,
    },
    {
      kind: 'select',
      key: 'ai.models.readiness',
      label: 'Readiness model',
      options: models,
      current: s.ai.models.readiness,
    },
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
    },
  ];
};

export const SettingsView = (): React.JSX.Element => {
  const deps = useDeps();
  const storage = useStorage();
  const ui = useUiState();
  const logLevel = useLogLevel();
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const [editingField, setEditingField] = useState<EditableField | undefined>(undefined);
  const [feedback, setFeedback] = useState<{ readonly tone: 'ok' | 'error'; readonly text: string } | undefined>(
    undefined
  );
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

  // Clamp cursor when the field set changes (e.g. provider switch shrinks model lists).
  useEffect(() => {
    if (cursor >= fields.length && fields.length > 0) setCursor(fields.length - 1);
  }, [fields, cursor]);

  useInput((input, key) => {
    if (ui.helpOpen || editingField !== undefined || ui.promptActive) return;
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
      if (field !== undefined) {
        setEditingField(field);
        setFeedback(undefined);
      }
    }
  });

  // Tie the prompt-active claim to the editing-field state so React's effect cleanup matches
  // the claim 1:1. Earlier we toggled imperatively from inside event handlers and the boolean
  // got clobbered by the PromptHost when its queue was empty.
  useEffect(() => (editingField !== undefined ? ui.claimPrompt() : undefined), [editingField, ui.claimPrompt]);

  const closeEditor = (): void => {
    setEditingField(undefined);
  };

  const submit = async (raw: string, field: EditableField): Promise<void> => {
    if (settings === undefined) {
      setFeedback({ tone: 'error', text: 'settings not loaded yet' });
      closeEditor();
      return;
    }
    // Provider switches route through the coordinated use-case — it atomically rebuilds the
    // four chain models so the persistence schema's discriminated union stays satisfied.
    if (field.key === 'ai.provider') {
      const providerFlow = createSettingsSetProviderFlow({ settingsRepo: deps.settingsRepo });
      const saved = await providerFlow.execute({ input: { provider: raw as AiProvider } });
      if (!saved.ok) {
        setFeedback({ tone: 'error', text: saved.error.error.message });
        closeEditor();
        return;
      }
      setFeedback({ tone: 'ok', text: `Provider = ${raw} · models reset to defaults` });
      closeEditor();
      await refresh();
      return;
    }
    const next = applySettingsKey(settings, field.key, raw);
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
    // Mirror persisted log-level into the live forwarder gate so the floor takes effect
    // immediately — otherwise the recent-events panel would keep using the boot-time level
    // until the TUI restarts.
    if (field.key === 'logging.level') {
      logLevel.setLevel(next.value.logging.level satisfies LogLevel);
    }
    setFeedback({ tone: 'ok', text: `${field.label} = ${raw}` });
    closeEditor();
    await refresh();
  };

  const renderEditor = (field: EditableField): React.JSX.Element => {
    if (field.kind === 'select') {
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
          <Card title="AI provider" tone="rule">
            <FieldList
              fields={[
                { label: 'Provider', value: valueFor('ai.provider') },
                { label: 'Refine', value: valueFor('ai.models.refine') },
                { label: 'Plan', value: valueFor('ai.models.plan') },
                { label: 'Ideate', value: valueFor('ai.models.ideate') },
                { label: 'Implement', value: valueFor('ai.models.implement') },
                { label: 'Readiness', value: valueFor('ai.models.readiness') },
              ]}
            />
          </Card>
          <Box marginTop={spacing.section}>
            <Card title="Harness budgets" tone="rule">
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
          <Box marginTop={spacing.section}>
            <Card title="Other" tone="rule">
              <FieldList
                fields={[
                  { label: 'Log level', value: valueFor('logging.level') },
                  { label: 'Concurrency', value: valueFor('concurrency.maxParallelTasks') },
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
