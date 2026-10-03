/**
 * Flows view — single screen showing every flow registered with the application. Each row is
 * enabled iff its triggers match the current state; otherwise the row is dimmed and the reason
 * surfaces in the focused-item description.
 *
 * Selecting an enabled row launches the flow via {@link useFlowLauncher}, registers the runner with
 * the session manager, and pushes the execute view with the new session id.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { ActionMenu, type MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import { StatusChip, sprintStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { flowRegistry, type FlowEntry } from '@src/application/registry.ts';
import { evaluateTriggers } from '@src/application/registry-triggers.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAppStateSnapshot } from '@src/application/ui/tui/runtime/use-app-state-snapshot.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { useFlowLauncher } from '@src/application/ui/tui/runtime/use-flow-launcher.ts';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { SprintPipeline } from '@src/application/ui/tui/components/sprint-pipeline.tsx';
import { NextStepList } from '@src/application/ui/tui/components/next-steps.tsx';
import { buildNextSteps, nextStepsInputFromSnapshot } from '@src/application/ui/shared/next-steps.ts';
import { sectionFor, sectionRank, visibleFlowsFor } from '@src/application/ui/tui/views/flows-visibility.ts';

// Sprint-state-machine visibility lives in `flows-visibility.ts` so it can be unit-tested
// without a React render. The view delegates section labelling, ordering, and the
// per-status allow-list to that module.

interface OrientationCardProps {
  readonly snapshot: AppStateSnapshot;
  readonly showAll: boolean;
}

/**
 * Status-aware orientation card rendered above the flow menu. Three regimes:
 *
 *   (a) No project selected — headline plus the pre-sprint next-step rows.
 *   (b) Project loaded but no sprint — same, one rung further along.
 *   (c) Sprint loaded — sprint name + status chip + the next-step rows for that status.
 *
 * Every regime's recommendation comes from `buildNextSteps`, the same table Home and the
 * settled ResultCard read. This view used to derive its own wording from `resolveSprintStage`,
 * which collapsed `planned`/`active` and ignored the ticket count in `draft` — so it disagreed
 * with Home on four of seven states and recommended `implement` where nothing was runnable.
 *
 * The `v show all` toggle hint is demoted to a secondary dim line below the card.
 */
const OrientationCard = ({ snapshot, showAll }: OrientationCardProps): React.JSX.Element => {
  const { project, sprint } = snapshot;
  const { steps } = buildNextSteps(nextStepsInputFromSnapshot(snapshot));
  const nextSteps = <NextStepList steps={steps} prefix={`${glyphs.emDash} next: `} />;
  const showAllHint = (
    <Box marginTop={spacing.gutter}>
      <Text dimColor>
        Press <Text bold>v</Text> to {showAll ? 'hide inapplicable flows' : 'show all flows with disabled reasons'}.
      </Text>
    </Box>
  );

  if (project === undefined) {
    return (
      <Card tone="info">
        <Text>No project selected.</Text>
        {nextSteps}
      </Card>
    );
  }

  if (sprint === undefined) {
    return (
      <Card tone="info">
        <Text>
          No sprint selected for <Text bold>{project.displayName}</Text>.
        </Text>
        {nextSteps}
      </Card>
    );
  }

  return (
    <Card tone="info">
      <Box flexDirection="row" gap={1}>
        <Text bold>{sprint.name}</Text>
        <StatusChip label={sprint.status.toUpperCase()} kind={sprintStatusKind(sprint.status)} />
      </Box>
      {nextSteps}
      {showAllHint}
    </Card>
  );
};

/**
 * Build one flow row's {@link MenuItem} — section, label, description, cost hint, and the
 * disabled state derived from the current snapshot's trigger inputs — wiring `onSelect` to the
 * shared flow launcher.
 */
const buildFlowMenuItem = (
  entry: FlowEntry,
  snapshot: AppStateSnapshot,
  launch: (flowId: string) => Promise<boolean>
): MenuItem => {
  const triggerEval = evaluateTriggers(entry.manifest.triggers, snapshot.triggerInputs);
  const item: MenuItem = {
    id: entry.manifest.id,
    section: sectionFor(entry.manifest.id),
    label: entry.manifest.title,
    description: entry.manifest.description,
    ...(entry.manifest.costHint !== undefined ? { costHint: entry.manifest.costHint } : {}),
    onSelect: (): void => {
      void launch(entry.manifest.id);
    },
  };
  if (!triggerEval.enabled) return { ...item, disabledReason: triggerEval.reason };
  return item;
};

interface UseFlowMenuItemsArgs {
  readonly state: ReturnType<typeof useAppStateSnapshot>['state'];
  readonly launch: (flowId: string) => Promise<boolean>;
  readonly showAll: boolean;
}

/**
 * Build the flow menu's items from the latest snapshot — filtered by state-machine visibility,
 * mapped to {@link MenuItem}s via {@link buildFlowMenuItem}, and sorted so the action menu's
 * section headers stay sticky (items in the same category render consecutively even when
 * registry order interleaves them).
 */
const useFlowMenuItems = ({ state, launch, showAll }: UseFlowMenuItemsArgs): readonly MenuItem[] =>
  useMemo<readonly MenuItem[]>(() => {
    if (state.kind !== 'ok') return [];
    const snapshot = state.value;
    // State-machine visibility: hide sprint-scoped flows that don't apply to the current
    // sprint status (or hide them all when no sprint is selected). `showAll` toggles every
    // flow back into view so the user can see what's reachable in other states — those
    // rows stay dimmed via `evaluateTriggers`.
    const visible = visibleFlowsFor({
      hasProject: snapshot.project !== undefined,
      ...(snapshot.sprint !== undefined ? { sprintStatus: snapshot.sprint.status } : {}),
      showAll,
    });
    const filteredRegistry = flowRegistry.filter((entry) => visible.has(entry.manifest.id));
    const built = filteredRegistry.map((entry) => buildFlowMenuItem(entry, snapshot, launch));
    return [...built].sort((a, b) => sectionRank(a.section ?? 'other') - sectionRank(b.section ?? 'other'));
  }, [state, launch, showAll]);

export const FlowsView = (): React.JSX.Element => {
  const ui = useUiState();
  const selection = useSelection();
  const [showAll, setShowAll] = useState<boolean>(false);
  useViewHints([
    { keys: '↑/↓', label: 'move' },
    { keys: '↵', label: 'launch' },
    { keys: 'r', label: 'reload state' },
    { keys: 'v', label: showAll ? 'hide inapplicable' : 'show all' },
  ]);

  const { state, reload } = useAppStateSnapshot();
  const { launch, launchError } = useFlowLauncher({ snapshot: state.kind === 'ok' ? state.value : undefined, reload });

  const items = useFlowMenuItems({ state, launch, showAll });

  // Refresh the cached breadcrumb status chip from every fresh snapshot load — flow chains
  // transition the sprint's status on disk (plan → planned, implement → review, close-sprint →
  // done) and the chip would otherwise wave the stale status until the next manual pick.
  // syncSprintStatus no-ops unless the loaded sprint is still the selected one.
  const syncSprintStatus = selection.syncSprintStatus;
  useEffect(() => {
    if (state.kind !== 'ok') return;
    const s = state.value.sprint;
    if (s !== undefined) syncSprintStatus(s.id, s.status);
  }, [state, syncSprintStatus]);

  // `r` re-fetches the snapshot so the menu's enabled/disabled state reflects the latest
  // storage read — useful after mutating something in a detail view and coming back. `v`
  // (visibility) toggles between the state-machine-filtered menu (default) and the full
  // registry; `s` is intentionally NOT used here because Home reserves it for Settings.
  useInput((input) => {
    if (ui.modalOpen) return;
    if (input === 'r') reload();
    if (input === 'v') setShowAll((v) => !v);
  });

  return (
    <ViewShell title="Flows" subtitle="Pick a flow to run" suppressScrollArrows>
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : state.kind !== 'ok' ? (
        <LoadingRow label="Loading state…" />
      ) : (
        <Box flexDirection="column">
          <SprintPipeline snapshot={state.value} />
          <Box marginTop={spacing.section}>
            <OrientationCard snapshot={state.value} showAll={showAll} />
          </Box>
          <Box marginTop={spacing.section}>
            <ActionMenu items={items} active={!ui.modalOpen} />
          </Box>
          {launchError !== undefined && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Text color={inkColors.error}>
                {glyphs.bullet} {launchError}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </ViewShell>
  );
};
