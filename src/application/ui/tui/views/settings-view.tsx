/** Settings view orchestrator — owns hooks, state, key handling, and prompt mounting. */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { PresetConfirm } from '@src/application/ui/tui/views/preset-confirm.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { useLogLevel } from '@src/application/ui/tui/runtime/log-level-context.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { useScrollAnchor } from '@src/application/ui/tui/components/scroll-region.tsx';
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
  activateField,
  buildSections,
  type EditableField,
  type SettingsSection,
} from '@src/application/ui/tui/views/settings-view-model.ts';

/** Feedback banner rendered under the active section — `undefined` clears it. */
type SettingsFeedback = { readonly tone: 'ok' | 'error'; readonly text: string } | undefined;

/** A field's current value with the active-cursor glyph. */
const FieldValue = ({ focused, value }: { readonly focused: boolean; readonly value: string }): React.JSX.Element => {
  const anchorRef = useScrollAnchor(focused);
  return (
    <Box ref={anchorRef}>
      <Text {...(focused ? { color: inkColors.primary } : {})} bold={focused}>
        {focused ? `${glyphs.actionCursor} ` : '  '}
        {value}
      </Text>
    </Box>
  );
};

/** Renders the current value + active-cursor glyph for `key` inside the active section's field list. */
const renderFieldValue = (activeFields: readonly EditableField[], cursor: number, key: string): React.ReactNode => {
  const focused = activeFields[cursor]?.key === key;
  const field = activeFields.find((f) => f.key === key);
  return <FieldValue focused={focused} value={field?.current ?? ''} />;
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
 * Owns the loaded `Settings` record and its load/mutate lifecycle: initial load, preset apply, and per-field submit.
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

/** Set of providers whose CLI binary resolved on PATH at mount time. */
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
 * Per-provider account-available model subset, resolved lazily after settings load — one probe per distinct provider
 * in the loaded config.
 */
const useAvailableModelsMap = (
  settings: Settings | undefined,
  availableModelsFor: (provider: AiProvider) => Promise<readonly string[]>
): ReadonlyMap<AiProvider, readonly string[]> => {
  const [availableModels, setAvailableModels] = useState<ReadonlyMap<AiProvider, readonly string[]>>(new Map());
  useEffect(() => {
    // `availableModelsFor` is always wired in production, but tests cast `{}` to `AppDeps`, so it can be undefined.
    if (settings === undefined || typeof availableModelsFor !== 'function') return;
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
 * Builds the section list from the loaded settings + resolved model catalog, and owns the section/cursor pointers
 * into it.
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
  /** `useMemo` keeps the same array reference across renders while the section's field set is unchanged. */
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
  readonly activeSectionId: SettingsSection['id'] | undefined;
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
 * Owns the Settings view's keyboard routing: `←/→` switch sections, `↑/↓`/j/k (plus PageUp/PageDown/Home/End) move
 * the cursor within the active section's fields, `↵`/`e` activates the focused field.
 */
const useSettingsKeyHandler = (params: SettingsKeyHandlerParams): void => {
  const {
    modalOpen,
    activeSectionId,
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

  const hasFields = activeFields.length > 0;
  const switchSection = (delta: 1 | -1): void => {
    setSectionIdx((i) => (i + delta + sections.length) % sections.length);
    setCursor(0);
    setFeedback(undefined);
  };
  const activate = (): void => {
    const field = activeFields[cursor];
    if (field !== undefined) onActivate(field);
  };
  const last = activeFields.length - 1;

  useViewKeys(
    [
      {
        keys: ['←', '→'],
        hint: 'section',
        enabled: sections.length > 0,
        run: (_i, key) => switchSection(key.rightArrow ? 1 : -1),
      },
      listMoveBinding,
      {
        keys: ['↑', '↓', 'j', 'k'],
        hint: 'move',
        hidden: true,
        enabled: hasFields,
        run: (input, key) =>
          setCursor((c) => (key.downArrow || input === 'j' ? Math.min(last, c + 1) : Math.max(0, c - 1))),
      },
      { keys: ['PgUp', 'Home'], hint: 'first', hidden: true, enabled: hasFields, run: () => setCursor(0) },
      { keys: ['PgDn', 'End'], hint: 'last', hidden: true, enabled: hasFields, run: () => setCursor(last) },
      { keys: ['↵'], hint: activeSectionId === 'presets' ? 'apply' : 'edit', enabled: hasFields, run: activate },
      { keys: ['e'], hint: 'edit', hidden: true, enabled: hasFields, run: activate },
    ],
    { active: !modalOpen && editingField === undefined && pendingPreset === undefined }
  );
};

interface SettingsViewBodyProps {
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
  readonly focusedKey: string | undefined;
  readonly storage: ReturnType<typeof useStorage>;
  readonly presetWarnings: readonly PresetWarning[];
  readonly feedback: SettingsFeedback;
}

/**
 * The Settings view's mutually-exclusive display states, in priority order: preset confirmation, field editor, load
 * error, loading spinner, then the section strip + active-section body.
 */
const SettingsViewBody = ({
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
  focusedKey,
  storage,
  presetWarnings,
  feedback,
}: SettingsViewBodyProps): React.JSX.Element => {
  if (pendingPreset !== undefined && settings !== undefined) {
    return (
      <PresetConfirm
        preset={pendingPreset}
        settings={settings}
        onApply={() => void onApplyPreset(pendingPreset)}
        onClose={onCancelPreset}
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
      {/* Column, not row: a row-direction box shrink-wraps its child so the body card hugs its
          content instead of spanning the view width. */}
      <Box flexDirection="column" paddingX={spacing.indent} marginTop={spacing.section}>
        <SectionBody
          section={activeSection}
          valueFor={valueFor}
          focusedKey={focusedKey}
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
  /** Warnings from the most recent apply-preset. */
  const [presetWarnings, setPresetWarnings] = useState<readonly PresetWarning[]>([]);

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
    activeSectionId: activeSection?.id,
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

  // Tie the prompt-active claim to the editing-field state so React's effect cleanup matches the claim 1:1.
  const claimPrompt = ui.claimPrompt;
  useEffect(
    () => (editingField !== undefined || pendingPreset !== undefined ? claimPrompt() : undefined),
    [editingField, pendingPreset, claimPrompt]
  );

  const valueFor = (key: string): React.ReactNode =>
    settings === undefined ? null : renderFieldValue(activeFields, cursor, key);

  return (
    <ViewShell title="Settings" subtitle={activeSection?.title ?? 'loading'} suppressScrollArrows>
      <SettingsViewBody
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
        focusedKey={activeFields[cursor]?.key}
        storage={storage}
        presetWarnings={presetWarnings}
        feedback={feedback}
      />
    </ViewShell>
  );
};
