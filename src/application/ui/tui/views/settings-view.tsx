/**
 * Settings view orchestrator — owns hooks, state, key handling, and prompt mounting. The
 * render-side render is factored into sibling files; this file's only responsibility is to
 * wire those pieces together with the EventBus + dependency-injected flow factories.
 *
 * `←/→` switch sections; `↑/↓` navigate fields inside the active section; `↵/e` mounts the
 * prompt appropriate to the field's type (SelectPrompt for enums + model catalogs, TextPrompt
 * for numbers / free-text strings). Most routes funnel through `applySettingsKey` (validation)
 * → `settingsSet` use-case (persistence) so the TUI and `ralphctl settings set` share a
 * single mutation grammar.
 *
 * Siblings:
 *   - `settings-view-model.ts`   — pure types + section builder
 *   - `settings-sections.tsx`    — section strip + active-section body switch
 *   - `preset-bar.tsx`           — preset section body
 *   - `ai-row.tsx`               — per-flow + Implement section bodies
 *   - `harness-row.tsx`          — harness budgets section body
 *   - `settings-editor.tsx`      — field-aware prompt mounting + provider-availability gate
 *   - `settings-mutations.ts`    — apply-key / set-provider / apply-preset routing
 *
 * AI configuration is per-flow. Each flow renders as a dedicated section with three editable
 * rows. Switching a row's provider routes through `settings-set-provider` (which rebuilds that
 * row's `{ provider, model }` from the new provider's defaults so the persistence schema stays
 * satisfied). Off-catalog persisted model values stay visible on read; the catalog gate only
 * constrains the editor surface.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { ConfirmPrompt } from '@src/application/ui/tui/prompts/confirm-prompt.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { useLogLevel } from '@src/application/ui/tui/runtime/log-level-context.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { createSettingsShowFlow } from '@src/application/flows/settings-show/flow.ts';
import type { PresetName } from '@src/business/settings/presets.ts';
import type { PresetWarning } from '@src/application/flows/settings-apply-preset/ctx.ts';
import { type AiProvider, type Settings, uniqueProvidersFromAi } from '@src/domain/entity/settings.ts';
import type { LogLevel } from '@src/domain/value/log-level.ts';
import { detectInstalledProviders } from '@src/integration/system/detect-cli.ts';
import { SettingsEditor } from '@src/application/ui/tui/views/settings-editor.tsx';
import { applyPreset, submitField } from '@src/application/ui/tui/views/settings-mutations.ts';
import { SectionBody, SectionStrip } from '@src/application/ui/tui/views/settings-sections.tsx';
import {
  buildSections,
  type EditableField,
  type SettingsSection,
} from '@src/application/ui/tui/views/settings-view-model.ts';

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
  /**
   * Per-provider account-available model subset, resolved lazily after the settings load. Keyed by
   * provider; absent entries fall back to the full catalog inside {@link buildSections}. Empty
   * while the availability probes are in flight — the full catalog renders, then re-renders
   * filtered once each provider resolves. Never blocks the view.
   */
  const [availableModels, setAvailableModels] = useState<ReadonlyMap<AiProvider, readonly string[]>>(new Map());
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

  // Resolve account-available models once settings load — one probe per distinct provider in the
  // loaded config. Non-blocking: each result folds into the map as it arrives, re-rendering the
  // affected provider's model options filtered. The probe never throws (fail open).
  const availableModelsFor = deps.availableModelsFor;
  useEffect(() => {
    if (settings === undefined || availableModelsFor === undefined) return;
    let cancelled = false;
    for (const provider of uniqueProvidersFromAi(settings.ai)) {
      void availableModelsFor(provider).then((models) => {
        if (cancelled) return;
        setAvailableModels((prev) => new Map(prev).set(provider, models));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [settings, availableModelsFor]);

  const sections = useMemo<readonly SettingsSection[]>(
    () => (settings === undefined ? [] : buildSections(settings, availableModels)),
    [settings, availableModels]
  );

  const activeSection = sections[sectionIdx];
  /**
   * `useMemo` keeps the same array reference across renders while the section's field set is
   * unchanged, which keeps the cursor-clamp effect below stable (running it on every render
   * would either no-op uselessly or fight the user's ↑/↓ presses).
   */
  const activeFields = useMemo<readonly EditableField[]>(() => activeSection?.fields ?? [], [activeSection]);

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
    if (key.pageUp) {
      // Per-section row count is small (≤ 8) so PgUp snaps to the first field.
      setCursor(0);
      return;
    }
    if (key.pageDown) {
      setCursor(activeFields.length - 1);
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(activeFields.length - 1);
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

  const handlePreset = async (preset: PresetName): Promise<void> => {
    const outcome = await applyPreset(preset, deps.settingsRepo);
    if (outcome.kind === 'error') {
      setFeedback({ tone: 'error', text: outcome.text });
      return;
    }
    setFeedback({ tone: 'ok', text: outcome.text });
    setPresetWarnings(outcome.warnings);
    await refresh();
  };

  const handleSubmit = async (raw: string, field: EditableField): Promise<void> => {
    if (settings === undefined) {
      setFeedback({ tone: 'error', text: 'settings not loaded yet' });
      closeEditor();
      return;
    }
    const outcome = await submitField(settings, field, raw, deps.settingsRepo);
    if (outcome.kind === 'error') {
      setFeedback({ tone: 'error', text: outcome.text });
      closeEditor();
      return;
    }
    if (outcome.next !== undefined && field.key === 'logging.level') {
      logLevel.setLevel(outcome.next.logging.level satisfies LogLevel);
    }
    setFeedback({ tone: 'ok', text: outcome.text });
    closeEditor();
    await refresh();
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
            if (yes) void handlePreset(preset);
          }}
          onCancel={() => setPendingPreset(undefined)}
        />
      ) : editingField !== undefined ? (
        <SettingsEditor
          field={editingField}
          installedProviders={installedProviders}
          onSubmit={(value) => void handleSubmit(value, editingField)}
          onCancel={closeEditor}
        />
      ) : loadError !== undefined ? (
        <Box paddingX={spacing.indent}>
          <Text color={inkColors.error}>Failed to load settings: {loadError}</Text>
        </Box>
      ) : settings === undefined || activeSection === undefined ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Loading…" />
        </Box>
      ) : (
        <Box flexDirection="column">
          <SectionStrip sections={sections} activeIdx={sectionIdx} />
          <Box marginTop={spacing.section}>
            <SectionBody
              section={activeSection}
              valueFor={valueFor}
              storage={storage}
              presetWarnings={presetWarnings}
            />
          </Box>
          {feedback !== undefined && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Text color={feedback.tone === 'ok' ? inkColors.primary : inkColors.error}>
                {feedback.tone === 'ok' ? glyphs.check : glyphs.cross} {feedback.text}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </ViewShell>
  );
};
