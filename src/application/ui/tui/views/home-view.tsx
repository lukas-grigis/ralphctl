/**
 * Home view — the persistent landing page.
 *
 * Layout:
 *   1. Banner (handled by ViewShell).
 *   2. Section stamp.
 *   3. State summary card: current project + sprint + counts.
 *   4. Pipeline map for the current sprint's lifecycle.
 *   5. Action menu — primary navigation (Flows, Projects, Sprints, Sessions, Settings, Doctor).
 *
 * The home view never starts a flow itself; it routes the user to the flows screen for that.
 * Keeping a single launch surface keeps the home action menu stable across sessions.
 *
 * Presentation chunks (state card, menu builder) live under `home-internals/`; this file
 * orchestrates state + effects + key handling.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { ActionMenu } from '@src/application/ui/tui/components/action-menu.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAppStateSnapshot } from '@src/application/ui/tui/runtime/use-app-state-snapshot.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { useLaunchCreateSprint } from '@src/application/ui/tui/runtime/use-launch-create-sprint.ts';
import { StateCard } from '@src/application/ui/tui/views/home-internals/state-card.tsx';
import { buildMenuItems } from '@src/application/ui/tui/views/home-internals/menu-items.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';

type SelectionApi = ReturnType<typeof useSelection>;

/**
 * Transient "✓ now on <sprint-name>" feedback line lives above the action menu for ~3 seconds
 * after any sprint switch — inline shortcut, picker pick, sprint-detail `m`, or create-sprint
 * completion. Same pattern as sprints-view's inline feedback. The interval is short enough to
 * not steal attention from the next action; long enough to confirm the switch landed.
 */
const SWITCH_FEEDBACK_MS = 3000;

/**
 * Transient "✓ now on <sprint-name>" line above the menu. Fed by the shared `selection.lastSwitch`
 * record — fires for picker / sprint-detail `m` / create-sprint reseat / inline shortcut from
 * another view. Auto-clears via a window check on each render (not an interval) so the line just
 * stops rendering after the threshold expires; a separate `dismissedAt` keeps user-driven "ack"
 * semantics out of scope here — the timer alone is sufficient.
 */
const useSwitchToast = (
  selection: SelectionApi
): { readonly visible: boolean; readonly lastSwitch: SelectionApi['lastSwitch'] } => {
  // Re-render once when the switch window expires so the toast disappears without waiting for
  // an external trigger. `+ 50ms` slack avoids edge cases where the timer fires fractionally
  // before the freshness check resolves to "stale". A real reducer bump is required: an
  // identity updater like `setLocalError((curr) => curr)` bails out of the re-render under
  // React's Object.is check, leaving the toast painted forever on an otherwise idle Home.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const lastSwitch = selection.lastSwitch;
  useEffect(() => {
    if (lastSwitch === undefined) return undefined;
    const elapsed = Date.now() - lastSwitch.at;
    const remaining = SWITCH_FEEDBACK_MS - elapsed;
    if (remaining <= 0) return undefined;
    const id = setTimeout(() => {
      // The render itself reads the freshness window — there's nothing to flip on this side
      // beyond forcing a paint.
      forceRender();
    }, remaining + 50);
    return (): void => clearTimeout(id);
  }, [lastSwitch]);

  const visible =
    lastSwitch !== undefined &&
    Date.now() - lastSwitch.at < SWITCH_FEEDBACK_MS &&
    lastSwitch.sprintId === selection.sprintId;

  return { visible, lastSwitch };
};

/**
 * Local error toasts (e.g. "✗ pick a project first") — pure local state because they don't
 * correspond to a sprint switch, just a rejected action. Shares the same fade duration as the
 * switch toast so the two read as one family of transient feedback.
 */
const useLocalErrorFlash = (): {
  readonly localError: string | undefined;
  readonly flashErr: (text: string) => void;
} => {
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const timerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const flashErr = useCallback((text: string): void => {
    setLocalError(text);
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setLocalError(undefined);
      timerRef.current = undefined;
    }, SWITCH_FEEDBACK_MS);
  }, []);
  // Drop the timer on unmount so a quick navigate-away doesn't leak a setState into a tree
  // that's no longer mounted.
  useEffect(
    () => (): void => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    []
  );
  return { localError, flashErr };
};

/**
 * Inline-shortcut + `+` hotkey for launching create-sprint. Watched outside the ActionMenu's
 * hotkey machinery because `+` is shift-bound on many keyboards (not portable as a registered
 * MenuItem hotkey glyph). Gating on `hasProject` matches the menu-row `disabledReason` semantics
 * so both entry points behave identically.
 */
const useCreateSprintHotkey = (args: {
  readonly modalOpen: boolean;
  readonly promptActive: boolean;
  readonly hasProject: boolean;
  readonly flashErr: (text: string) => void;
  readonly launchCreateSprint: () => Promise<void>;
}): void => {
  useInput(
    (input) => {
      if (args.modalOpen) return;
      if (input !== '+') return;
      if (!args.hasProject) {
        args.flashErr(`${glyphs.cross} pick a project first (Projects ${glyphs.arrowRight} open one)`);
        return;
      }
      void args.launchCreateSprint();
    },
    { isActive: !args.promptActive }
  );
};

interface HomeMenuItemsArgs {
  readonly router: ReturnType<typeof useRouter>;
  readonly selection: SelectionApi;
  readonly hasProject: boolean;
  readonly stateLoaded: boolean;
  readonly snapshotLoading: boolean;
  readonly currentSprint: Sprint | undefined;
  readonly recentSprints: readonly Sprint[];
  readonly switchSprintDisabled: string | undefined;
  readonly addTicketDisabled: string | undefined;
  readonly launchCreateSprint: () => Promise<void>;
}

/** Builds the action-menu rows via {@link buildMenuItems}, wiring each callback to the router /
 *  selection / create-sprint launcher. Isolated so the orchestrator's dependency array doesn't
 *  double as inline callback wiring. */
const useHomeMenuItems = ({
  router,
  selection,
  hasProject,
  stateLoaded,
  snapshotLoading,
  currentSprint,
  recentSprints,
  switchSprintDisabled,
  addTicketDisabled,
  launchCreateSprint,
}: HomeMenuItemsArgs): ReturnType<typeof buildMenuItems> =>
  useMemo(
    () =>
      buildMenuItems({
        hasProject,
        stateLoaded,
        loading: snapshotLoading,
        currentSprint,
        recentSprints,
        selectionSprintId: selection.sprintId,
        switchSprintDisabled,
        addTicketDisabled,
        onPushHome: (id) => router.push({ id }),
        onPushAddTicket: (sprintId) => router.push({ id: 'add-ticket', props: { sprintId } }),
        onSwitchSprint: (s) => selection.setSprint(s.id, s.name, s.status),
        onLaunchCreateSprint: () => {
          void launchCreateSprint();
        },
      }),
    [
      router,
      hasProject,
      stateLoaded,
      snapshotLoading,
      switchSprintDisabled,
      addTicketDisabled,
      selection,
      recentSprints,
      currentSprint,
      launchCreateSprint,
    ]
  );

/** The two transient feedback lines shown above the action menu — switch confirmation and
 *  local errors are mutually rare, but both may in principle be visible in the same render. */
const HomeFeedbackLines = ({
  switchToastVisible,
  switchLabel,
  localError,
}: {
  readonly switchToastVisible: boolean;
  readonly switchLabel: string | undefined;
  readonly localError: string | undefined;
}): React.JSX.Element => (
  <>
    {switchToastVisible && switchLabel !== undefined && (
      <Box paddingX={spacing.indent} marginTop={spacing.section}>
        <Text color={inkColors.success}>{`${glyphs.check} now on ${switchLabel}`}</Text>
      </Box>
    )}
    {localError !== undefined && (
      <Box paddingX={spacing.indent} marginTop={spacing.section}>
        <Text color={inkColors.error}>{localError}</Text>
      </Box>
    )}
  </>
);

export const HomeView = (): React.JSX.Element => {
  const router = useRouter();
  const ui = useUiState();
  const selection = useSelection();

  const { state } = useAppStateSnapshot();

  const snapshot = state.kind === 'ok' ? state.value : undefined;
  const hasProject = snapshot?.project !== undefined;
  const currentSprint = snapshot?.sprint;
  // Covers the pre-fetch `idle` tick as well as `loading` — matches the guard sibling views
  // (sprints-view, pick-sprint-view, projects-view, …) use for their own `LoadingRow`. Without
  // it, the single-render `idle` frame shows a blank hero card indistinguishable from "no data".
  const snapshotLoading = state.kind === 'loading' || state.kind === 'idle';

  // Refresh the cached breadcrumb status chip from every fresh snapshot load — flows route
  // back to Home after a run settles, so this is where a plan/implement/close transition
  // first becomes visible. syncSprintStatus no-ops unless the loaded sprint is still the
  // selected one, so firing on every load is safe.
  const syncSprintStatus = selection.syncSprintStatus;
  useEffect(() => {
    if (currentSprint !== undefined) syncSprintStatus(currentSprint.id, currentSprint.status);
  }, [currentSprint, syncSprintStatus]);
  // Stabilise the empty-array fallback so downstream `useMemo`s keyed on `recentSprints` don't
  // re-run whenever this render's `??` would allocate a fresh `[]`.
  const recentSprints = useMemo(() => snapshot?.recentSprints ?? [], [snapshot?.recentSprints]);

  const { visible: switchToastVisible, lastSwitch } = useSwitchToast(selection);
  const { localError, flashErr } = useLocalErrorFlash();

  // Launch create-sprint via the shared sprint-bound launcher. Reseat-on-completion fires
  // `selection.setSprint` — which writes to `lastSwitch` and feeds the toast line. Failures
  // (no project) flash a local error instead.
  const launchCreateSprint = useLaunchCreateSprint({
    onError: flashErr,
    noProjectMessage: `${glyphs.cross} pick a project first (Projects ${glyphs.arrowRight} open one)`,
  });

  useCreateSprintHotkey({
    modalOpen: ui.modalOpen,
    promptActive: ui.promptActive,
    hasProject,
    flashErr,
    launchCreateSprint,
  });

  // Gating reasons for the two new quick actions. Computed inline so the menu's `disabledReason`
  // pulls directly from the snapshot — no extra effect / state needed.
  const switchSprintDisabled = !hasProject ? 'no project loaded' : undefined;
  const addTicketDisabled =
    currentSprint === undefined
      ? 'pick a sprint first'
      : currentSprint.status !== 'draft'
        ? `sprint is ${currentSprint.status} — tickets can only be added in draft`
        : undefined;

  // Initial cursor: prefer the row that matches the current selection so the user lands on
  // their working sprint instead of the top of the list. `useMemo` instead of state because the
  // menu owns the cursor; this is only the seed.
  const initialMenuIndex = useMemo<number>(() => {
    if (currentSprint === undefined) return 0;
    const idx = recentSprints.findIndex((s) => s.id === currentSprint.id);
    return idx >= 0 ? idx : 0;
  }, [currentSprint, recentSprints]);

  const items = useHomeMenuItems({
    router,
    selection,
    hasProject,
    stateLoaded: state.kind === 'ok',
    snapshotLoading,
    currentSprint,
    recentSprints,
    switchSprintDisabled,
    addTicketDisabled,
    launchCreateSprint,
  });

  return (
    <ViewShell title="Home" subtitle="Where do we start today?">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : (
        <Box flexDirection="column">
          <StateCard state={state.kind === 'ok' ? state.value : undefined} loading={snapshotLoading} />
          <HomeFeedbackLines
            switchToastVisible={switchToastVisible}
            switchLabel={lastSwitch?.sprintLabel}
            localError={localError}
          />
          <Box marginY={spacing.section}>
            <ActionMenu items={items} active={!ui.modalOpen} initialIndex={initialMenuIndex} />
          </Box>
        </Box>
      )}
    </ViewShell>
  );
};
