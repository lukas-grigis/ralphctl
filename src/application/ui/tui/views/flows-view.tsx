/**
 * Flows view — single screen showing every flow registered with the application. Each row is
 * enabled iff its triggers match the current state; otherwise the row is dimmed and the reason
 * surfaces in the focused-item description.
 *
 * Selecting an enabled row launches the flow via {@link launchFlow}, registers the runner with
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
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAppStateSnapshot } from '@src/application/ui/tui/runtime/use-app-state-snapshot.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { useRouter, type RouterApi, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import type { SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import type { PromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { openFlowSession } from '@src/application/ui/tui/runtime/open-flow-session.ts';
import {
  launchFlow,
  type LaunchExtras,
  type LauncherDeps,
  type LaunchResult,
} from '@src/application/ui/shared/launcher.ts';
import { launchSprintBoundFlow } from '@src/application/ui/shared/launch/sprint-bound.ts';
import {
  runCustomizePicker,
  type CustomizePickerResult,
} from '@src/application/ui/tui/views/flows-customize-picker.ts';
import { runRepositorySelection } from '@src/application/ui/tui/views/flows-repository-picker.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { getImplementRoleOverrides } from '@src/application/ui/tui/runtime/implement-role-overrides.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { SprintPipeline, resolveSprintStage } from '@src/application/ui/tui/components/sprint-pipeline.tsx';
import { sectionFor, sectionRank, visibleFlowsFor } from '@src/application/ui/tui/views/flows-visibility.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import type { Settings } from '@src/domain/entity/settings.ts';

// Sprint-state-machine visibility lives in `flows-visibility.ts` so it can be unit-tested
// without a React render. The view delegates section labelling, ordering, and the
// per-status allow-list to that module.

/** Flow id whose launch needs special sprint-rebinding handling (see the `onSelect` handler). */
const CREATE_SPRINT_FLOW_ID = 'create-sprint';

/**
 * Some flows in the registry are use-case shaped (one-shot, no chain runner) and the TUI
 * has dedicated views for them. Route those directly instead of falling through to
 * `launchFlow`, which only knows how to construct chain flows.
 */
const viewRouteFor = (flowId: string, snapshot: AppStateSnapshot): ViewEntry | undefined => {
  switch (flowId) {
    case 'doctor':
      return { id: 'doctor' };
    case 'settings':
      return { id: 'settings' };
    case 'remove-ticket':
      return snapshot.sprint ? { id: 'sprint-detail', props: { sprintId: snapshot.sprint.id } } : undefined;
    case 'export-context':
      return { id: 'export-context' };
    case 'export-requirements':
      return { id: 'export-requirements' };
    case 'create-pr':
      return { id: 'create-pr' };
    default:
      return undefined;
  }
};

interface OrientationCardProps {
  readonly snapshot: AppStateSnapshot;
  readonly showAll: boolean;
}

/**
 * Status-aware orientation card rendered above the flow menu. Three regimes:
 *
 *   (a) No project selected — points the user toward Projects / P picker.
 *   (b) Project loaded but no sprint — points the user toward Sprints.
 *   (c) Sprint loaded — shows sprint name + status + the single most-eligible next action
 *       derived from the same stage logic the pipeline map uses.
 *
 * The `v show all` toggle hint is demoted to a secondary dim line below the card.
 */
const OrientationCard = ({ snapshot, showAll }: OrientationCardProps): React.JSX.Element => {
  const { project, sprint, triggerInputs } = snapshot;

  if (project === undefined) {
    return (
      <Card tone="info">
        <Text>
          No project selected {glyphs.emDash} pick one with{' '}
          <Text bold color={inkColors.highlight}>
            P
          </Text>{' '}
          or open Projects to create one.
        </Text>
      </Card>
    );
  }

  if (sprint === undefined) {
    return (
      <Card tone="info">
        <Text>
          No sprint selected for <Text bold>{project.displayName}</Text> {glyphs.emDash}{' '}
          {snapshot.sprintCount === 0
            ? ' create one from Sprints, then return here.'
            : ' pick one with S or open Sprints.'}
        </Text>
      </Card>
    );
  }

  // Sprint loaded — derive the recommended next action from the pipeline stage.
  const stage = resolveSprintStage(snapshot);
  let nextAction: string;
  switch (stage) {
    case 'Refine':
      nextAction = `refine tickets (${String(triggerInputs.pendingTicketCount)} pending)`;
      break;
    case 'Plan':
      nextAction = `plan tasks (${String(triggerInputs.approvedTicketCount)} approved ticket${triggerInputs.approvedTicketCount !== 1 ? 's' : ''})`;
      break;
    case 'Implement':
      nextAction =
        triggerInputs.resumableTaskCount > 0
          ? `implement (${String(triggerInputs.resumableTaskCount)} task${triggerInputs.resumableTaskCount !== 1 ? 's' : ''} ready)`
          : 'implement';
      break;
    case 'Review':
      nextAction = 'apply review feedback';
      break;
    case 'Done':
      nextAction = 'open a pull request';
      break;
    default:
      nextAction = 'pick a flow below';
  }

  return (
    <Card tone="info">
      <Box flexDirection="row" gap={1}>
        <Text bold>{sprint.name}</Text>
        <StatusChip label={sprint.status.toUpperCase()} kind={sprintStatusKind(sprint.status)} />
        <Text dimColor>
          {glyphs.emDash} next: {nextAction}
        </Text>
      </Box>
      <Box marginTop={spacing.gutter}>
        <Text dimColor>
          Press <Text bold>v</Text> to {showAll ? 'hide inapplicable flows' : 'show all flows with disabled reasons'}.
        </Text>
      </Box>
    </Card>
  );
};

/**
 * Assemble the per-launch {@link LaunchExtras} from the resolved repository id, the customize
 * picker's outcome, and the fresh settings snapshot. Implement role overrides prefer the
 * picker's per-role result; falling back to the CLI-derived module holder (parsed from
 * `--implement-{generator,evaluator}-{provider,model}`) only for the `implement` flow when the
 * picker ran in single-row mode (i.e. every AI flow other than implement).
 */
const buildLaunchExtras = (
  picker: CustomizePickerResult,
  entry: FlowEntry,
  chosenRepositoryId: RepositoryId | undefined,
  ui: ReturnType<typeof useUiState>,
  settings: Settings
): LaunchExtras => {
  const implementRoleOverrides =
    picker.kind === 'implement'
      ? picker.implementRoleOverrides
      : entry.manifest.id === 'implement'
        ? getImplementRoleOverrides()
        : undefined;
  const override = picker.kind === 'single' ? picker.override : undefined;
  // Thread the resolved repository id as a pre-selection. When the repo-selection step ran,
  // `chosenRepositoryId` is the user's fresh pick; otherwise (single-repo / non-repo flows) it
  // falls back to the session pin so the flow's own `pickRepositoryLeaf` still pre-selects the
  // lone / previously-chosen repo.
  const repositoryId = chosenRepositoryId ?? ui.sessionRepositoryId;
  return {
    ...(repositoryId !== undefined ? { repositoryId } : {}),
    ...(override !== undefined ? { override } : {}),
    ...(implementRoleOverrides !== undefined ? { implementRoleOverrides } : {}),
    settingsSnapshot: settings,
  };
};

interface RunFlowLaunchDeps {
  readonly selection: ReturnType<typeof useSelection>;
  readonly sessions: SessionManager;
}

/**
 * Dispatch the flow launch. create-sprint and close-sprint change which sprint (or status) the
 * user is "on" — route them through the sprint-bound wrapper so the post-completion selection
 * reseat happens in one place instead of leaving the global selection stale. create-sprint
 * additionally strips the launch-time sprint from the snapshot: the new sprint doesn't exist
 * yet, so pinning the PREVIOUS sprint onto the run's descriptor would mislabel every panel;
 * `onSprintResolved` pins the real one once known. Every other flow launches directly.
 */
const runFlowLaunch = async (
  launcherDeps: LauncherDeps,
  entry: FlowEntry,
  snapshot: AppStateSnapshot,
  launchExtras: LaunchExtras,
  { selection, sessions }: RunFlowLaunchDeps
): Promise<LaunchResult> => {
  const sprintBound = entry.manifest.id === CREATE_SPRINT_FLOW_ID || entry.manifest.id === 'close-sprint';
  if (!sprintBound) return launchFlow(launcherDeps, entry.manifest.id, snapshot, launchExtras);

  const { sprint: _staleSprint, ...snapshotWithoutSprint } = snapshot;
  void _staleSprint;
  return launchSprintBoundFlow(
    launcherDeps,
    entry.manifest.id,
    entry.manifest.id === CREATE_SPRINT_FLOW_ID ? snapshotWithoutSprint : snapshot,
    {
      ...launchExtras,
      onReseat: ({ id, name, status }) => {
        if (entry.manifest.id === CREATE_SPRINT_FLOW_ID) {
          // A brand-new sprint can't collide with a mid-run switch — always reseat (and let
          // the "✓ now on …" toast fire via lastSwitch).
          selection.setSprint(id, name, status);
          return;
        }
        // close-sprint: the sprint stays selected but its status flipped to done on disk —
        // refresh the chip without replaying the switch toast. syncSprintStatus no-ops when
        // the user moved to a different sprint mid-run, so a late completion never yanks them
        // back.
        if (status !== undefined) selection.syncSprintStatus(id, status);
      },
      onSprintResolved: (runnerId, { id, name }) => {
        sessions.setPinnedSprint(runnerId, id, name);
      },
    }
  );
};

/**
 * Subscribe BEFORE `start()` so we don't miss the synchronous completion of a fast-path flow.
 * Captures the chosen repository id from the final ctx for subsequent launches in this session.
 * Self-unsubscribes on terminal events so every flow launch doesn't pin a dead listener (and its
 * closure scope, incl. the `ui` ref + the event's `ctx` object) to the runner's listener Set
 * across a long TUI session — historically a load-bearing OOM contributor.
 */
const attachRepositoryCapture = (runner: Runner<unknown>, ui: ReturnType<typeof useUiState>): void => {
  const unsubRepoCapture: () => void = runner.subscribe((event) => {
    if (event.type === 'failed' || event.type === 'aborted') {
      unsubRepoCapture();
      return;
    }
    if (event.type !== 'completed') return;
    const ctx = event.ctx as { readonly repository?: { readonly id: RepositoryId } };
    if (ctx.repository !== undefined) ui.setSessionRepositoryId(ctx.repository.id);
    unsubRepoCapture();
  });
};

/** Everything a flow row's click handler needs, threaded once from {@link useFlowMenuItems}. */
interface FlowMenuItemHandlerCtx {
  readonly deps: AppDeps;
  readonly queue: PromptQueue;
  readonly storage: StoragePaths;
  readonly ui: ReturnType<typeof useUiState>;
  readonly selection: ReturnType<typeof useSelection>;
  readonly sessions: SessionManager;
  readonly router: RouterApi;
  readonly reload: () => void;
  readonly setLaunchError: (message: string | undefined) => void;
}

/**
 * Build the click handler for one flow row: route-check → interactive prompt → repository
 * selection → customize picker → launch → session registration, in the order the flow menu has
 * always used.
 */
const createFlowSelectHandler = (
  entry: FlowEntry,
  snapshot: AppStateSnapshot,
  handlerCtx: FlowMenuItemHandlerCtx
): (() => Promise<void>) => {
  const { deps, queue, storage, ui, selection, sessions, router, reload, setLaunchError } = handlerCtx;
  return async (): Promise<void> => {
    setLaunchError(undefined);

    // Use-case-shaped flows (doctor, settings-*, ticket-*) don't go through the chain
    // launcher — they have dedicated views. Route there directly.
    const route = viewRouteFor(entry.manifest.id, snapshot);
    if (route !== undefined) {
      router.push(route);
      return;
    }

    const interactive = createInkInteractivePrompt(queue);

    // Re-read settings from disk now so provider/model changes made via the Settings
    // view propagate. `deps.settings` is the boot-time snapshot and goes stale across
    // any settings write; the on-disk repo is the source of truth.
    const freshSettings = await deps.settingsRepo.load();
    const settings = freshSettings.ok ? freshSettings.value : deps.settings;

    // Pre-launch repository selection — for repo-selecting flows (detect-scripts /
    // detect-skills / readiness) against a multi-repo project, ask which repository the
    // run targets BEFORE the provider picker (the sequence reads "pick repo, then
    // customize provider"). The session-pinned repo (`ui.sessionRepositoryId`) is offered
    // first as a SOFT default — re-pickable every launch — rather than a HARD lock that
    // would make `pickRepositoryLeaf` skip its prompt forever. Single-repo projects and
    // non-repo flows return `kind: 'skip'` (no prompt); the chain's own `pickRepositoryLeaf`
    // auto-selects the lone repo / handles the empty-project error.
    const repoSelection = await runRepositorySelection({
      interactive,
      flowId: entry.manifest.id,
      flowTitle: entry.manifest.title,
      project: snapshot.project,
      pinnedRepositoryId: ui.sessionRepositoryId,
    });
    if (repoSelection.kind === 'cancel') return;
    const chosenRepositoryId = repoSelection.kind === 'selected' ? repoSelection.repositoryId : undefined;
    // Re-pin immediately so the new choice is the default on the next launch and the
    // post-completion capture below just re-affirms it (no conflict / double-prompt).
    if (chosenRepositoryId !== undefined) ui.setSessionRepositoryId(chosenRepositoryId);

    // Pre-launch customize picker — for AI-driven flows the user gets Start /
    // Customize / Cancel. Customize walks provider → model → effort for each row
    // (implement walks generator then evaluator). Settings are never mutated; per-launch
    // overrides are passed through {@link LaunchExtras}. Non-AI flows return
    // `kind: 'defaults'` without prompting.
    const picker = await runCustomizePicker({
      interactive,
      flowId: entry.manifest.id,
      flowTitle: entry.manifest.title,
      settings,
      // exactOptionalPropertyTypes: only pass the key when defined — the picker arg is
      // `?`-optional (absent), not `| undefined`. Absent ⇒ picker falls back to modelCatalogFor.
      ...(deps.availableModelsFor !== undefined ? { availableModelsFor: deps.availableModelsFor } : {}),
    });
    if (picker.kind === 'cancel') return;

    const launchExtras = buildLaunchExtras(picker, entry, chosenRepositoryId, ui, settings);
    const launcherDeps = { app: deps, interactive, storage, runInTerminal: getRunInTerminal() };
    const result = await runFlowLaunch(launcherDeps, entry, snapshot, launchExtras, { selection, sessions });
    if (!result.ok) {
      setLaunchError(`${entry.manifest.title}: ${result.reason}`);
      return;
    }
    attachRepositoryCapture(result.runner, ui);
    // Register + start + route via the shared tail. `replace` (not push) so the flow menu
    // isn't left on the stack behind the run. The trailing reload refreshes this menu's
    // enabled/disabled state immediately at launch (e.g. a flow-status trigger flips the
    // moment the session registers); freshness on COMPLETION comes separately, from
    // `useAppStateSnapshot`'s session-transition subscription firing once the run reaches
    // a terminal status — see `use-session-transition-reload.ts`.
    openFlowSession({ sessions, router }, result, entry.manifest.id, { mode: 'replace' });
    reload();
  };
};

/**
 * Build one flow row's {@link MenuItem} — section, label, description, cost hint, and the
 * disabled state derived from the current snapshot's trigger inputs — wiring `onSelect` to the
 * click handler built by {@link createFlowSelectHandler}.
 */
const buildFlowMenuItem = (
  entry: FlowEntry,
  snapshot: AppStateSnapshot,
  handlerCtx: FlowMenuItemHandlerCtx
): MenuItem => {
  const triggerEval = evaluateTriggers(entry.manifest.triggers, snapshot.triggerInputs);
  const item: MenuItem = {
    id: entry.manifest.id,
    section: sectionFor(entry.manifest.id),
    label: entry.manifest.title,
    description: entry.manifest.description,
    ...(entry.manifest.costHint !== undefined ? { costHint: entry.manifest.costHint } : {}),
    onSelect: createFlowSelectHandler(entry, snapshot, handlerCtx),
  };
  if (!triggerEval.enabled) return { ...item, disabledReason: triggerEval.reason };
  return item;
};

interface UseFlowMenuItemsArgs {
  readonly state: ReturnType<typeof useAppStateSnapshot>['state'];
  readonly deps: AppDeps;
  readonly queue: PromptQueue;
  readonly storage: StoragePaths;
  readonly sessions: SessionManager;
  readonly router: RouterApi;
  readonly reload: () => void;
  readonly showAll: boolean;
  readonly ui: ReturnType<typeof useUiState>;
  readonly selection: ReturnType<typeof useSelection>;
  readonly setLaunchError: (message: string | undefined) => void;
}

/**
 * Build the flow menu's items from the latest snapshot — filtered by state-machine visibility,
 * mapped to {@link MenuItem}s via {@link buildFlowMenuItem}, and sorted so the action menu's
 * section headers stay sticky (items in the same category render consecutively even when
 * registry order interleaves them).
 */
const useFlowMenuItems = ({
  state,
  deps,
  queue,
  storage,
  sessions,
  router,
  reload,
  showAll,
  ui,
  selection,
  setLaunchError,
}: UseFlowMenuItemsArgs): readonly MenuItem[] =>
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
    const handlerCtx: FlowMenuItemHandlerCtx = {
      deps,
      queue,
      storage,
      ui,
      selection,
      sessions,
      router,
      reload,
      setLaunchError,
    };
    const built = filteredRegistry.map((entry) => buildFlowMenuItem(entry, snapshot, handlerCtx));
    // Sort by section so the action menu's section headers stay sticky (items in the same
    // category render consecutively even when registry order interleaves them).
    return [...built].sort((a, b) => sectionRank(a.section ?? 'other') - sectionRank(b.section ?? 'other'));
    // setLaunchError is a useState setter (stable identity across renders); the linter can't see
    // that through the hook boundary once it's threaded in as a plain parameter instead of a
    // same-scope closure reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, deps, queue, storage, sessions, router, reload, showAll, ui, selection]);

export const FlowsView = (): React.JSX.Element => {
  const ui = useUiState();
  const deps = useDeps();
  const selection = useSelection();
  const router = useRouter();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();
  const [launchError, setLaunchError] = useState<string | undefined>(undefined);
  const [showAll, setShowAll] = useState<boolean>(false);
  useViewHints([
    { keys: '↑/↓', label: 'move' },
    { keys: '↵', label: 'launch' },
    { keys: 'r', label: 'reload state' },
    { keys: 'v', label: showAll ? 'hide inapplicable' : 'show all' },
  ]);

  const { state, reload } = useAppStateSnapshot();

  const items = useFlowMenuItems({
    state,
    deps,
    queue,
    storage,
    sessions,
    router,
    reload,
    showAll,
    ui,
    selection,
    setLaunchError,
  });

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
