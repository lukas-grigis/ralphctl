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
 *   r         reload
 *
 * A `defaultFor` flow always renders "always on (default)" regardless of any phase-folder copy —
 * default loading doesn't go through the phase folder at all (see `flowChipVisual`'s doc comment).
 */

import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useListWindow, type ListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { LoadErrorRow, LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { FeedbackLine, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { MultiSelectPrompt } from '@src/application/ui/tui/prompts/multi-select-prompt.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad, type AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { SkillRow } from '@src/application/ui/tui/views/skills-view-internals/skill-row.tsx';
import { disableOptions, enableOptions } from '@src/application/ui/tui/views/skills-view-internals/picker-options.ts';
import {
  confirmTitle,
  type ConfirmState,
  type PickerState,
  useSkillCatalogActions,
} from '@src/application/ui/tui/views/skills-view-internals/use-skill-catalog-actions.ts';

/** Non-list rows consumed by ViewShell chrome + summary line + overflow rows + feedback. */
const CHROME_ROWS = 8;
/** Approximate rendered height (rows) of one `SkillRow` card. */
const ROW_HEIGHT = 6;

interface SkillsBodyProps {
  readonly helpOpen: boolean;
  readonly state: AsyncLoadState<readonly SkillCatalogEntry[], unknown>;
  readonly picker: PickerState | undefined;
  readonly confirmState: ConfirmState | undefined;
  readonly entries: readonly SkillCatalogEntry[];
  readonly window: ListWindow;
  readonly visibleItems: readonly SkillCatalogEntry[];
  readonly focusedIndex: number;
  readonly bundledNames: ReadonlySet<string>;
  readonly operatorSkillsRoot: string;
  readonly actionFeedback: StructuredFeedback | undefined;
  readonly onSubmitPicker: (flows: readonly FlowId[]) => void;
  readonly onCancelPicker: () => void;
  readonly onSubmitConfirm: (confirmed: boolean) => void;
}

/** Loading / error / picker / confirm / empty / list-of-rows presentation — pure props in. */
const SkillsBody = ({
  helpOpen,
  state,
  picker,
  confirmState,
  entries,
  window,
  visibleItems,
  focusedIndex,
  bundledNames,
  operatorSkillsRoot,
  actionFeedback,
  onSubmitPicker,
  onCancelPicker,
  onSubmitConfirm,
}: SkillsBodyProps): React.JSX.Element => {
  if (helpOpen) return <HelpOverlay />;
  if (state.kind === 'loading' || state.kind === 'idle') return <LoadingRow label="Loading skill catalog…" />;
  if (state.kind === 'error') return <LoadErrorRow message="Failed to load the skill catalog." />;

  if (picker !== undefined) {
    return (
      <Box flexDirection="column" paddingX={spacing.indent}>
        <Text bold>
          {picker.kind === 'enable' ? 'Enable' : 'Disable'} &quot;{picker.entry.name}&quot; for:
        </Text>
        <MultiSelectPrompt
          message="space toggle · a select-all · ↵ confirm"
          options={picker.kind === 'enable' ? enableOptions(picker.entry) : disableOptions(picker.entry)}
          initialSelectedValues={picker.kind === 'enable' ? picker.entry.recommendedFor : []}
          onSubmit={(values) => onSubmitPicker(values as readonly FlowId[])}
          onCancel={onCancelPicker}
        />
      </Box>
    );
  }

  if (confirmState !== undefined) {
    return (
      <ConfirmCard
        title={<Text bold>{confirmTitle(confirmState)}</Text>}
        body={<Text dimColor>Local edits in the selected flow(s) will be permanently lost.</Text>}
        message={confirmState.kind === 'disable' ? 'Remove?' : 'Overwrite?'}
        onSubmit={onSubmitConfirm}
        onCancel={() => onSubmitConfirm(false)}
      />
    );
  }

  if (entries.length === 0) {
    return <EmptyState title="No skills bundled" hint="Nothing to browse — this build ships no skills." />;
  }

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
      <OverflowRow direction="above" count={window.start} />
      {visibleItems.map((entry, localIdx) => (
        <SkillRow
          key={entry.name}
          entry={entry}
          focused={window.start + localIdx === focusedIndex}
          isBundled={bundledNames.has(entry.name)}
        />
      ))}
      <OverflowRow direction="below" count={entries.length - window.end} />
      <FeedbackLine text={actionFeedback} />
    </Box>
  );
};

export const SkillsView = (): React.JSX.Element => {
  const deps = useDeps();
  const ui = useUiState();
  const bp = useBreakpoint();

  const { state, reload } = useAsyncLoad<readonly SkillCatalogEntry[]>(async () => {
    const r = await deps.skillCatalog.list();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, [deps.skillCatalog]);
  const entries = state.kind === 'ok' ? state.value : [];

  const actions = useSkillCatalogActions(deps.skillCatalog, reload);
  const { picker, confirmState, bundledNames } = actions;

  const claimPrompt = ui.claimPrompt;
  useEffect(() => (picker !== undefined ? claimPrompt() : undefined), [picker, claimPrompt]);

  const listActive = !ui.modalOpen && picker === undefined && confirmState === undefined;
  const visibleRows = Math.max(2, Math.min(6, Math.floor((bp.rows - CHROME_ROWS) / ROW_HEIGHT)));
  const { window, visibleItems, focusedIndex, focusedItem } = useListWindow<SkillCatalogEntry>({
    items: entries,
    getId: (e) => e.name,
    visibleRows,
    active: listActive,
  });

  useViewHints([
    { keys: '↑/↓/j/k', label: 'move' },
    { keys: 'e', label: 'enable' },
    { keys: 'd', label: 'disable' },
    { keys: 'u', label: 'update' },
    { keys: 'U', label: 'update all' },
    { keys: 'r', label: 'reload' },
  ]);

  useInput((input) => {
    if (!listActive || actions.busy) return;
    if (input === 'U') {
      actions.runUpdateAll();
      return;
    }
    if (input === 'r') {
      actions.flashInfo(`${glyphs.refresh} reloading…`);
      reload();
      return;
    }
    const target = focusedItem;
    if (target === undefined) return;
    if (input === 'e') actions.startEnable(target);
    else if (input === 'd') actions.startDisable(target);
    else if (input === 'u') actions.runUpdate(target);
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
        operatorSkillsRoot={String(deps.storage.operatorSkillsRoot)}
        actionFeedback={actions.actionFeedback}
        onSubmitPicker={(flows) => actions.submitPicker(flows)}
        onCancelPicker={actions.cancelPicker}
        onSubmitConfirm={actions.submitConfirm}
      />
    </ViewShell>
  );
};
