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

/**
 * Transient "✓ now on <sprint-name>" feedback line lives above the action menu for ~3 seconds
 * after any sprint switch — inline shortcut, picker pick, sprint-detail `m`, or create-sprint
 * completion. Same pattern as sprints-view's inline feedback. The interval is short enough to
 * not steal attention from the next action; long enough to confirm the switch landed.
 */
const SWITCH_FEEDBACK_MS = 3000;

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

  // Transient "✓ now on <sprint-name>" line above the menu. Two sources feed it:
  //   1. The shared `selection.lastSwitch` record — fires for picker / sprint-detail `m` /
  //      create-sprint reseat / inline shortcut from another view. Auto-clears via a window
  //      check on each render (not an interval) so the line just stops rendering after the
  //      threshold expires. A separate `dismissedAt` keeps user-driven "ack" semantics out of
  //      scope here — the timer alone is sufficient.
  //   2. Local error toasts (e.g. "✗ pick a project first") — set inline by handlers below
  //      via `flashErr`. These are pure local state because they don't correspond to a switch.
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const errorTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const flashErr = useCallback((text: string): void => {
    setLocalError(text);
    if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setLocalError(undefined);
      errorTimerRef.current = undefined;
    }, SWITCH_FEEDBACK_MS);
  }, []);
  // Drop the error timer on unmount so a quick navigate-away doesn't leak a setState into a
  // tree that's no longer mounted. The switch line has no per-mount timer (it reads
  // `selection.lastSwitch.at` on each render and disappears once the window elapses) so it
  // needs no cleanup.
  useEffect(
    () => (): void => {
      if (errorTimerRef.current !== undefined) clearTimeout(errorTimerRef.current);
    },
    []
  );

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

  const switchToastVisible =
    lastSwitch !== undefined &&
    Date.now() - lastSwitch.at < SWITCH_FEEDBACK_MS &&
    lastSwitch.sprintId === selection.sprintId;

  // Launch create-sprint via the shared sprint-bound launcher. Reseat-on-completion fires
  // `selection.setSprint` — which writes to `lastSwitch` and feeds the toast line. Failures
  // (no project) flash a local error instead.
  const launchCreateSprint = useLaunchCreateSprint({
    onError: flashErr,
    noProjectMessage: `${glyphs.cross} pick a project first (Projects ${glyphs.arrowRight} open one)`,
  });

  // Inline-shortcut + `+` hotkey. We watch for `+` outside the ActionMenu's hotkey machinery
  // because `+` is shift-bound on many keyboards (not portable as a registered MenuItem hotkey
  // glyph). Gating on `hasProject` matches the menu-row `disabledReason` semantics so both
  // entry points behave identically.
  useInput(
    (input) => {
      if (ui.modalOpen) return;
      if (input !== '+') return;
      if (!hasProject) {
        flashErr(`${glyphs.cross} pick a project first (Projects ${glyphs.arrowRight} open one)`);
        return;
      }
      void launchCreateSprint();
    },
    { isActive: !ui.promptActive }
  );

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

  const items = useMemo(
    () =>
      buildMenuItems({
        hasProject,
        stateLoaded: state.kind === 'ok',
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
      state.kind,
      snapshotLoading,
      switchSprintDisabled,
      addTicketDisabled,
      selection,
      recentSprints,
      currentSprint,
      launchCreateSprint,
    ]
  );

  return (
    <ViewShell title="Home" subtitle="Where do we start today?">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : (
        <Box flexDirection="column">
          <StateCard state={state.kind === 'ok' ? state.value : undefined} loading={snapshotLoading} />
          {switchToastVisible && lastSwitch !== undefined && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Text color={inkColors.success}>{`${glyphs.check} now on ${lastSwitch.sprintLabel}`}</Text>
            </Box>
          )}
          {localError !== undefined && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Text color={inkColors.error}>{localError}</Text>
            </Box>
          )}
          <Box marginY={spacing.section}>
            <ActionMenu items={items} active={!ui.modalOpen} initialIndex={initialMenuIndex} />
          </Box>
        </Box>
      )}
    </ViewShell>
  );
};
