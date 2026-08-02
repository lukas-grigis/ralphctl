/**
 * Skills catalog view — browse every bundled skill, see where it's currently enabled (per flow)
 * and whether that copy is in sync, and enable / disable / update it. The filesystem under
 * `<appRoot>/skills/<flow>/<name>/` is the single source of truth (see
 * `integration/ai/skills/phase/catalog.ts`); this view is a thin driver over
 * `AppDeps.skillCatalog`. Action sequencing (enable/disable/update/update-all, confirm gating)
 * lives in `skills-view-internals/use-skill-catalog-actions.ts`; the per-row layout lives in
 * `skills-view-internals/skill-row.tsx`.
 *
 * Local keys:
 *   ↑/↓/j/k   move the focus cursor (windowed list)
 *   e         enable the focused skill for picked flows (multi-select, recommendedFor preselected)
 *   d         disable the focused skill for picked flows (multi-select over currently-installed flows)
 *   u         update the focused skill from the bundle (confirms first if it would overwrite a
 *             locally-modified copy)
 *   U         update every install whose status is update-available, catalog-wide (never touches
 *             locally-modified or manual installs — no confirm needed)
 *   c         clear the focused skill's saved opt-out (`settings.ai.skills.<flow>.disabled`) —
 *             only offered when it actually has one; otherwise the only way to clear it is
 *             re-running a flow's customize picker and choosing "remember" again
 *   r         reload
 *
 * A `defaultFor` flow always renders "always on (default)" regardless of any phase-folder copy —
 * default loading doesn't go through the phase folder at all (see `flowChipVisual`'s doc comment).
 */

import React, { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useListWindow, type ListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { AsyncListFrame } from '@src/application/ui/tui/components/async-list-frame.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { FeedbackLine, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { MultiSelectPrompt } from '@src/application/ui/tui/prompts/multi-select-prompt.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { glyphs, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad, type AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys, type ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { SkillRow } from '@src/application/ui/tui/views/skills-view-internals/skill-row.tsx';
import {
  disableOptions,
  enableOptions,
  enablePreselect,
} from '@src/application/ui/tui/views/skills-view-internals/picker-options.ts';
import {
  confirmTitle,
  type ConfirmState,
  type PickerState,
  useSkillCatalogActions,
} from '@src/application/ui/tui/views/skills-view-internals/use-skill-catalog-actions.ts';

/** Non-list rows consumed by ViewShell chrome + summary line + overflow rows + feedback. */
const CHROME_ROWS = 8;
/**
 * Rendered height (rows) of one `SkillRow` card at its tallest: border top, name, description,
 * chip strip, "recommended:" line, border bottom, plus the section margin below the card.
 */
const ROW_HEIGHT = 7;

interface SkillsViewState {
  readonly entries: readonly SkillCatalogEntry[];
  readonly settings: Settings | undefined;
}

/**
 * Loader for `useAsyncLoad` — the catalog listing plus a settings read, used both to make a
 * "default" chip honest ("default, off (saved)") and to drive the clear-opt-out action. A
 * settings read failure is non-fatal — the catalog still renders, chips just lose that nuance
 * and the clear-opt-out action has nothing to clear. Extracted so `SkillsView` stays under the
 * per-function line budget.
 */
const loadSkillsViewState = async (deps: AppDeps): Promise<SkillsViewState> => {
  const r = await deps.skillCatalog.list();
  if (!r.ok) throw new Error(r.error.message);
  const settingsR = await deps.settingsRepo.load();
  return { entries: r.value, settings: settingsR.ok ? settingsR.value : undefined };
};

interface SkillsBodyProps {
  readonly helpOpen: boolean;
  readonly state: AsyncLoadState<SkillsViewState, unknown>;
  readonly picker: PickerState | undefined;
  readonly confirmState: ConfirmState | undefined;
  readonly entries: readonly SkillCatalogEntry[];
  readonly window: ListWindow;
  readonly visibleItems: readonly SkillCatalogEntry[];
  readonly focusedIndex: number;
  readonly bundledNames: ReadonlySet<string>;
  readonly savedDisabled: (flowId: FlowId) => ReadonlySet<string>;
  readonly operatorSkillsRoot: string;
  readonly actionFeedback: StructuredFeedback | undefined;
  readonly onSubmitPicker: (flows: readonly FlowId[]) => void;
  readonly onCancelPicker: () => void;
  readonly onSubmitConfirm: (confirmed: boolean) => void;
}

/** Multi-select over the flows an enable / disable action should touch. */
const SkillFlowPicker = ({
  picker,
  onSubmit,
  onCancel,
}: {
  readonly picker: PickerState;
  readonly onSubmit: (flows: readonly FlowId[]) => void;
  readonly onCancel: () => void;
}): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent}>
    <Text bold>
      {picker.kind === 'enable' ? 'Enable' : 'Disable'} &quot;{picker.entry.name}&quot; for:
    </Text>
    <MultiSelectPrompt
      message="space toggle · a select-all · ↵ confirm"
      options={picker.kind === 'enable' ? enableOptions(picker.entry) : disableOptions(picker.entry)}
      initialSelectedValues={picker.kind === 'enable' ? enablePreselect(picker.entry) : []}
      onSubmit={(values) => onSubmit(values as readonly FlowId[])}
      onCancel={onCancel}
    />
  </Box>
);

/** Summary line + windowed catalog rows + action feedback. */
const SkillsList = ({
  entries,
  window,
  visibleItems,
  focusedIndex,
  bundledNames,
  savedDisabled,
  operatorSkillsRoot,
  actionFeedback,
}: Pick<
  SkillsBodyProps,
  | 'entries'
  | 'window'
  | 'visibleItems'
  | 'focusedIndex'
  | 'bundledNames'
  | 'savedDisabled'
  | 'operatorSkillsRoot'
  | 'actionFeedback'
>): React.JSX.Element => {
  const updateAvailableCount = entries.reduce(
    (acc, e) => acc + e.installs.filter((i) => i.status === 'update-available').length,
    0
  );
  const anyOptIn = entries.some((e) => e.installs.length > 0);

  return (
    <Box flexDirection="column">
      <Box paddingX={spacing.indent} marginBottom={spacing.section}>
        <Text dimColor>
          {String(entries.length)} skill(s) {glyphs.bullet} {String(updateAvailableCount)} update
          {updateAvailableCount === 1 ? '' : 's'} available
          {!anyOptIn &&
            ` ${glyphs.bullet} no opt-in copies yet — press e to enable one (folder: ${operatorSkillsRoot}/<flow>/<skill>)`}
        </Text>
      </Box>
      <OverflowRow direction="above" count={window.hiddenAbove} />
      {visibleItems.map((entry, localIdx) => (
        <SkillRow
          key={entry.name}
          entry={entry}
          focused={window.start + localIdx === focusedIndex}
          isBundled={bundledNames.has(entry.name)}
          savedDisabled={savedDisabled}
        />
      ))}
      <OverflowRow direction="below" count={window.hiddenBelow} />
      <FeedbackLine text={actionFeedback} />
    </Box>
  );
};

/** Loading / error / picker / confirm / empty / list-of-rows presentation — pure props in. */
const SkillsBody = ({
  helpOpen,
  state,
  picker,
  confirmState,
  onSubmitPicker,
  onCancelPicker,
  onSubmitConfirm,
  ...list
}: SkillsBodyProps): React.JSX.Element => {
  // The help screen, the flow picker and the destructive-overwrite confirm each take over the
  // whole frame; everything below them is the ordinary async ladder.
  const overlay = helpOpen ? (
    <HelpOverlay />
  ) : picker !== undefined ? (
    <SkillFlowPicker picker={picker} onSubmit={onSubmitPicker} onCancel={onCancelPicker} />
  ) : confirmState !== undefined ? (
    <ConfirmCard
      title={<Text bold>{confirmTitle(confirmState)}</Text>}
      body={<Text dimColor>Local edits in the selected flow(s) will be permanently lost.</Text>}
      message={confirmState.kind === 'disable' ? 'Remove?' : 'Overwrite?'}
      onSubmit={onSubmitConfirm}
      onCancel={() => onSubmitConfirm(false)}
    />
  ) : undefined;

  return (
    <AsyncListFrame
      {...(overlay !== undefined ? { overlay } : {})}
      state={state}
      loadingLabel="Loading skill catalog…"
      errorMessage="Failed to load the skill catalog."
      isEmpty={list.entries.length === 0}
      empty={<EmptyState title="No skills bundled" hint="Nothing to browse — this build ships no skills." />}
    >
      <SkillsList {...list} />
    </AsyncListFrame>
  );
};

interface SkillsKeysInput {
  readonly actions: ReturnType<typeof useSkillCatalogActions>;
  readonly focusedItem: SkillCatalogEntry | undefined;
  readonly canClearOptOut: boolean;
  readonly reload: () => void;
}

/**
 * The catalog key map. Extracted from the view body so the component stays a wiring surface and
 * the table of "key → what it does → when it is live" reads in one place.
 */
const skillsKeyBindings = ({
  actions,
  focusedItem,
  canClearOptOut,
  reload,
}: SkillsKeysInput): readonly ViewKeyBinding[] => [
  { keys: ['↑', '↓', 'j', 'k'], hint: 'move' },
  {
    keys: ['e'],
    hint: 'enable',
    run: () => {
      if (focusedItem !== undefined) actions.startEnable(focusedItem);
    },
  },
  {
    keys: ['d'],
    hint: 'disable',
    run: () => {
      if (focusedItem !== undefined) actions.startDisable(focusedItem);
    },
  },
  {
    keys: ['u'],
    hint: 'update',
    run: () => {
      if (focusedItem !== undefined) actions.runUpdate(focusedItem);
    },
  },
  { keys: ['U'], hint: 'update all', run: () => actions.runUpdateAll() },
  {
    keys: ['c'],
    hint: 'clear opt-out',
    enabled: canClearOptOut,
    run: () => {
      if (focusedItem !== undefined) actions.clearSavedOptOut(focusedItem);
    },
  },
  {
    keys: ['r'],
    hint: 'reload',
    run: () => {
      actions.flashInfo(`${glyphs.refresh} reloading…`);
      reload();
    },
  },
];

export const SkillsView = (): React.JSX.Element => {
  const deps = useDeps();
  const ui = useUiState();
  const bp = useBreakpoint();

  const { state, reload } = useAsyncLoad<SkillsViewState>(
    () => loadSkillsViewState(deps),
    [deps.skillCatalog, deps.settingsRepo]
  );
  const entries = state.kind === 'ok' ? state.value.entries : [];
  const settings = state.kind === 'ok' ? state.value.settings : undefined;
  const skills = settings?.ai.skills;

  const EMPTY_NAMES: ReadonlySet<string> = useMemo(() => new Set(), []);
  const savedDisabled = useMemo(() => {
    const byFlow = new Map<FlowId, ReadonlySet<string>>();
    for (const flowId of FLOW_IDS) byFlow.set(flowId, new Set(skills?.[flowId]?.disabled ?? []));
    return (flowId: FlowId): ReadonlySet<string> => byFlow.get(flowId) ?? EMPTY_NAMES;
  }, [skills, EMPTY_NAMES]);

  const actions = useSkillCatalogActions(deps.skillCatalog, deps.settingsRepo, settings, reload);
  const { picker, confirmState, bundledNames } = actions;

  const claimPrompt = ui.claimPrompt;
  useEffect(() => (picker !== undefined ? claimPrompt() : undefined), [picker, claimPrompt]);

  const listActive = !ui.modalOpen && picker === undefined && confirmState === undefined;
  const { window, visibleItems, focusedIndex, focusedItem } = useListWindow<SkillCatalogEntry>({
    items: entries,
    getId: (e) => e.name,
    visibleRows: listCapacity(bp.rows, { rowHeight: ROW_HEIGHT, chromeRows: CHROME_ROWS, min: 2, max: 6 }),
    active: listActive,
  });

  // One flag for the hint and the handler — pressing `c` only does something when the focused
  // entry actually has a durable opt-out saved somewhere, so the hint hides in lockstep.
  const canClearOptOut = focusedItem !== undefined && actions.savedOptOutFlows(focusedItem).length > 0;

  useViewKeys(skillsKeyBindings({ actions, focusedItem, canClearOptOut, reload }), {
    active: listActive && !actions.busy,
  });

  return (
    <ViewShell title="Skills" subtitle="Browse, enable, disable, and update opt-in skills" suppressScrollArrows>
      <SkillsBody
        helpOpen={ui.helpOpen}
        state={state}
        picker={picker}
        confirmState={confirmState}
        entries={entries}
        window={window}
        visibleItems={visibleItems}
        focusedIndex={focusedIndex}
        bundledNames={bundledNames}
        savedDisabled={savedDisabled}
        operatorSkillsRoot={String(deps.storage.operatorSkillsRoot)}
        actionFeedback={actions.actionFeedback}
        onSubmitPicker={(flows) => actions.submitPicker(flows)}
        onCancelPicker={actions.cancelPicker}
        onSubmitConfirm={actions.submitConfirm}
      />
    </ViewShell>
  );
};
