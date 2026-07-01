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
 *
 * `SettingsView` itself is a short composition of local hooks (`useSettingsData`,
 * `useInstalledProviders`, `useAvailableModelsMap`, `useSectionNavigation`,
 * `useSettingsKeyHandler`) plus the `SettingsViewBody` display-state subcomponent — each owns one
 * cohesive slice of the view's state/effects so the orchestrator itself stays a thin wire-up.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
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
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import { detectInstalledProviders } from '@src/integration/system/detect-cli.ts';
import { SettingsEditor } from '@src/application/ui/tui/views/settings-editor.tsx';
import { applyPreset, submitField } from '@src/application/ui/tui/views/settings-mutations.ts';
import { SectionBody, SectionStrip } from '@src/application/ui/tui/views/settings-sections.tsx';
import {
  buildSections,
  type EditableField,
  type SettingsSection,
} from '@src/application/ui/tui/views/settings-view-model.ts';

/** Feedback banner rendered under the active section — `undefined` clears it. */
type SettingsFeedback = { readonly tone: 'ok' | 'error'; readonly text: string } | undefined;

/** `-1` (previous) / `1` (next) section-switch delta for `←`/`[` and `→`/`]`; `undefined` otherwise. */
const sectionKeyDelta = (input: string, key: Pick<Key, 'leftArrow' | 'rightArrow'>): -1 | 1 | undefined => {
  if (key.leftArrow || input === '[') return -1;
  if (key.rightArrow || input === ']') return 1;
  return undefined;
};

/**
 * Next cursor index for `↑/↓`/j/k (clamped ±1) and PageUp/PageDown/Home/End (snap to an end);
 * `undefined` when `input`/`key` isn't a cursor-movement key.
 */
const cursorKeyIndex = (
  input: string,
  key: Pick<Key, 'upArrow' | 'downArrow' | 'pageUp' | 'pageDown' | 'home' | 'end'>,
  cursor: number,
  length: number
): number | undefined => {
  if (key.upArrow || input === 'k') return Math.max(0, cursor - 1);
  if (key.downArrow || input === 'j') return Math.min(length - 1, cursor + 1);
  if (key.pageUp || key.home) return 0;
  if (key.pageDown || key.end) return length - 1;
  return undefined;
};

/** Renders the current value + active-cursor glyph for `key` inside the active section's field list. */
const renderFieldValue = (activeFields: readonly EditableField[], cursor: number, key: string): React.ReactNode => {
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

interface FieldActivationSetters {
  readonly setFeedback: (feedback: SettingsFeedback) => void;
  readonly setPresetWarnings: (warnings: readonly PresetWarning[]) => void;
  readonly setPendingPreset: (preset: PresetName) => void;
  readonly setEditingField: (field: EditableField) => void;
}

/** `↵/e` activation for the focused field — opens the preset-confirm prompt or the field editor. */
const activateField = (field: EditableField, setters: FieldActivationSetters): void => {
  setters.setFeedback(undefined);
  if (field.kind === 'preset') {
    setters.setPresetWarnings([]);
    setters.setPendingPreset(field.preset);
    return;
  }
  setters.setPresetWarnings([]);
  setters.setEditingField(field);
};

interface SettingsDataParams {
  readonly settingsRepo: SettingsRepository;
  readonly setLogLevel: (level: LogLevel) => void;
  readonly setFeedback: (feedback: SettingsFeedback) => void;
  readonly setPresetWarnings: (warnings: readonly PresetWarning[]) => void;
  readonly closeEditor: () => void;
}

interface SettingsDataResult {
  readonly settings: Settings | undefined;
  readonly loadError: string | undefined;
  readonly handlePreset: (preset: PresetName) => Promise<void>;
  readonly handleSubmit: (raw: string, field: EditableField) => Promise<void>;
}

/**
 * Owns the loaded `Settings` record and its load/mutate lifecycle: initial load, preset apply,
 * and per-field submit. Every mutation re-runs `refresh` on success so the view always reflects
 * the persisted record rather than an optimistic local patch.
 */
const useSettingsData = (params: SettingsDataParams): SettingsDataResult => {
  const { settingsRepo, setLogLevel, setFeedback, setPresetWarnings, closeEditor } = params;
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  const refresh = React.useCallback(async (): Promise<void> => {
    const flow = createSettingsShowFlow({ settingsRepo });
    const result = await flow.execute({ input: undefined });
    if (result.ok) setSettings(result.value.ctx.output!);
    else setLoadError(result.error.error.message);
  }, [settingsRepo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handlePreset = async (preset: PresetName): Promise<void> => {
    const outcome = await applyPreset(preset, settingsRepo);
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
    const outcome = await submitField(settings, field, raw, settingsRepo);
    if (outcome.kind === 'error') {
      setFeedback({ tone: 'error', text: outcome.text });
      closeEditor();
      return;
    }
    if (outcome.next !== undefined && field.key === 'logging.level') {
      setLogLevel(outcome.next.logging.level satisfies LogLevel);
    }
    setFeedback({ tone: 'ok', text: outcome.text });
    closeEditor();
    await refresh();
  };

  return { settings, loadError, handlePreset, handleSubmit };
};

/**
 * Set of providers whose CLI binary resolved on PATH at mount time. Probed once per Settings
 * session — the per-row Settings editor never re-probes; the user has to leave and re-enter
 * Settings to refresh the gate (matches the apply-preset / launch-time probe sites). Resolves to
 * `undefined` while the probe is in flight; the provider picker treats `undefined` as "all
 * enabled" so the picker is usable in the rare frame between mount and probe-completion.
 */
const useInstalledProviders = (): ReadonlySet<AiProvider> | undefined => {
  const [installedProviders, setInstalledProviders] = useState<ReadonlySet<AiProvider> | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void detectInstalledProviders().then((installed) => {
      if (!cancelled) setInstalledProviders(installed);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return installedProviders;
};

/**
 * Per-provider account-available model subset, resolved lazily after settings load — one probe
 * per distinct provider in the loaded config. Keyed by provider; absent entries fall back to the
 * full catalog inside {@link buildSections}. Empty while the availability probes are in flight —
 * the full catalog renders, then re-renders filtered once each provider resolves. The probe never
 * throws (fail open); never blocks the view.
 */
const useAvailableModelsMap = (
  settings: Settings | undefined,
  availableModelsFor: ((provider: AiProvider) => Promise<readonly string[]>) | undefined
): ReadonlyMap<AiProvider, readonly string[]> => {
  const [availableModels, setAvailableModels] = useState<ReadonlyMap<AiProvider, readonly string[]>>(new Map());
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
  return availableModels;
};

interface SectionNavigationResult {
  readonly sections: readonly SettingsSection[];
  readonly sectionIdx: number;
  readonly setSectionIdx: React.Dispatch<React.SetStateAction<number>>;
  readonly cursor: number;
  readonly setCursor: React.Dispatch<React.SetStateAction<number>>;
  readonly activeSection: SettingsSection | undefined;
  readonly activeFields: readonly EditableField[];
}

/**
 * Builds the section list from the loaded settings + resolved model catalog, and owns the
 * section/cursor pointers into it — including the two clamp effects that keep both pointers in
 * bounds when the underlying field set shrinks (e.g. a provider switch resets a section's model
 * options, or the section list itself changes shape).
 */
const useSectionNavigation = (
  settings: Settings | undefined,
  availableModels: ReadonlyMap<AiProvider, readonly string[]>
): SectionNavigationResult => {
  const sections = useMemo<readonly SettingsSection[]>(
    () => (settings === undefined ? [] : buildSections(settings, availableModels)),
    [settings, availableModels]
  );
  const [sectionIdx, setSectionIdx] = useState(0);
  const [cursor, setCursor] = useState(0);
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

  return { sections, sectionIdx, setSectionIdx, cursor, setCursor, activeSection, activeFields };
};

interface SettingsKeyHandlerParams {
  readonly modalOpen: boolean;
  readonly editingField: EditableField | undefined;
  readonly pendingPreset: PresetName | undefined;
  readonly sections: readonly SettingsSection[];
  readonly activeFields: readonly EditableField[];
  readonly cursor: number;
  readonly setSectionIdx: React.Dispatch<React.SetStateAction<number>>;
  readonly setCursor: React.Dispatch<React.SetStateAction<number>>;
  readonly setFeedback: (feedback: SettingsFeedback) => void;
  readonly onActivate: (field: EditableField) => void;
}

/**
 * Owns the Settings view's global keyboard routing: `←/→`/`[`/`]` switch sections, `↑/↓`/j/k
 * (plus PageUp/PageDown/Home/End) move the cursor within the active section's fields, `↵`/`e`
 * activates the focused field. Muted while a modal overlay, editor, or preset confirmation is
 * active — those own their own `useInput` handlers.
 */
const useSettingsKeyHandler = (params: SettingsKeyHandlerParams): void => {
  const {
    modalOpen,
    editingField,
    pendingPreset,
    sections,
    activeFields,
    cursor,
    setSectionIdx,
    setCursor,
    setFeedback,
    onActivate,
  } = params;

  useInput((input, key) => {
    if (modalOpen || editingField !== undefined || pendingPreset !== undefined) return;
    if (sections.length === 0) return;
    const sectionDelta = sectionKeyDelta(input, key);
    if (sectionDelta !== undefined) {
      setSectionIdx((i) => (i + sectionDelta + sections.length) % sections.length);
      setCursor(0);
      setFeedback(undefined);
      return;
    }
    if (activeFields.length === 0) return;
    const nextCursor = cursorKeyIndex(input, key, cursor, activeFields.length);
    if (nextCursor !== undefined) {
      setCursor(nextCursor);
      return;
    }
    if (key.return || input === 'e') {
      const field = activeFields[cursor];
      if (field !== undefined) onActivate(field);
    }
  });
};

interface SettingsViewBodyProps {
  readonly helpOpen: boolean;
  readonly pendingPreset: PresetName | undefined;
  readonly onApplyPreset: (preset: PresetName) => Promise<void>;
  readonly onCancelPreset: () => void;
  readonly editingField: EditableField | undefined;
  readonly installedProviders: ReadonlySet<AiProvider> | undefined;
  readonly onSubmitField: (raw: string, field: EditableField) => Promise<void>;
  readonly onCancelField: () => void;
  readonly loadError: string | undefined;
  readonly settings: Settings | undefined;
  readonly activeSection: SettingsSection | undefined;
  readonly sections: readonly SettingsSection[];
  readonly sectionIdx: number;
  readonly valueFor: (key: string) => React.ReactNode;
  readonly storage: ReturnType<typeof useStorage>;
  readonly presetWarnings: readonly PresetWarning[];
  readonly feedback: SettingsFeedback;
}

/**
 * The Settings view's mutually-exclusive display states, in priority order: help overlay, preset
 * confirmation, field editor, load error, loading spinner, then the section strip + active-section
 * body. Isolated from `SettingsView` so the hook-heavy orchestrator stays a short composition.
 */
const SettingsViewBody = ({
  helpOpen,
  pendingPreset,
  onApplyPreset,
  onCancelPreset,
  editingField,
  installedProviders,
  onSubmitField,
  onCancelField,
  loadError,
  settings,
  activeSection,
  sections,
  sectionIdx,
  valueFor,
  storage,
  presetWarnings,
  feedback,
}: SettingsViewBodyProps): React.JSX.Element => {
  if (helpOpen) return <HelpOverlay />;

  if (pendingPreset !== undefined) {
    return (
      <ConfirmPrompt
        message={`Apply preset ${pendingPreset}? This overwrites all AI rows.`}
        defaultYes={false}
        onSubmit={(yes) => {
          onCancelPreset();
          if (yes) void onApplyPreset(pendingPreset);
        }}
        onCancel={onCancelPreset}
      />
    );
  }

  if (editingField !== undefined) {
    return (
      <SettingsEditor
        field={editingField}
        installedProviders={installedProviders}
        onSubmit={(value) => void onSubmitField(value, editingField)}
        onCancel={onCancelField}
      />
    );
  }

  if (loadError !== undefined) {
    return (
      <Box paddingX={spacing.indent}>
        <Text color={inkColors.error}>Failed to load settings: {loadError}</Text>
      </Box>
    );
  }

  if (settings === undefined || activeSection === undefined) {
    return (
      <Box paddingX={spacing.indent}>
        <Spinner label="Loading…" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <SectionStrip sections={sections} activeIdx={sectionIdx} />
      <Box marginTop={spacing.section}>
        <SectionBody section={activeSection} valueFor={valueFor} storage={storage} presetWarnings={presetWarnings} />
      </Box>
      {feedback !== undefined && (
        <Box paddingX={spacing.indent} marginTop={spacing.section}>
          <Text color={feedback.tone === 'ok' ? inkColors.primary : inkColors.error}>
            {feedback.tone === 'ok' ? glyphs.check : glyphs.cross} {feedback.text}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export const SettingsView = (): React.JSX.Element => {
  const deps = useDeps();
  const storage = useStorage();
  const ui = useUiState();
  const logLevel = useLogLevel();

  const [editingField, setEditingField] = useState<EditableField | undefined>(undefined);
  /** Pending preset confirmation — populated when the user activates a preset button. */
  const [pendingPreset, setPendingPreset] = useState<PresetName | undefined>(undefined);
  const [feedback, setFeedback] = useState<SettingsFeedback>(undefined);
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

  const closeEditor = (): void => setEditingField(undefined);

  const { settings, loadError, handlePreset, handleSubmit } = useSettingsData({
    settingsRepo: deps.settingsRepo,
    setLogLevel: logLevel.setLevel,
    setFeedback,
    setPresetWarnings,
    closeEditor,
  });
  const installedProviders = useInstalledProviders();
  const availableModels = useAvailableModelsMap(settings, deps.availableModelsFor);
  const { sections, sectionIdx, setSectionIdx, cursor, setCursor, activeSection, activeFields } = useSectionNavigation(
    settings,
    availableModels
  );

  useSettingsKeyHandler({
    modalOpen: ui.modalOpen,
    editingField,
    pendingPreset,
    sections,
    activeFields,
    cursor,
    setSectionIdx,
    setCursor,
    setFeedback,
    onActivate: (field) => activateField(field, { setFeedback, setPresetWarnings, setPendingPreset, setEditingField }),
  });

  // Tie the prompt-active claim to the editing-field state so React's effect cleanup matches
  // the claim 1:1. Earlier we toggled imperatively from inside event handlers and the boolean
  // got clobbered by the PromptHost when its queue was empty.
  const claimPrompt = ui.claimPrompt;
  useEffect(
    () => (editingField !== undefined || pendingPreset !== undefined ? claimPrompt() : undefined),
    [editingField, pendingPreset, claimPrompt]
  );

  const valueFor = (key: string): React.ReactNode =>
    settings === undefined ? null : renderFieldValue(activeFields, cursor, key);

  return (
    <ViewShell title="Settings" subtitle="←/→ section · ↑/↓ navigate · ↵ edit · esc cancel">
      <SettingsViewBody
        helpOpen={ui.helpOpen}
        pendingPreset={pendingPreset}
        onApplyPreset={handlePreset}
        onCancelPreset={() => setPendingPreset(undefined)}
        editingField={editingField}
        installedProviders={installedProviders}
        onSubmitField={handleSubmit}
        onCancelField={closeEditor}
        loadError={loadError}
        settings={settings}
        activeSection={activeSection}
        sections={sections}
        sectionIdx={sectionIdx}
        valueFor={valueFor}
        storage={storage}
        presetWarnings={presetWarnings}
        feedback={feedback}
      />
    </ViewShell>
  );
};
