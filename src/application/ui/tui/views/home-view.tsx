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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { ActionMenu } from '@src/application/ui/tui/components/action-menu.tsx';
import { inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { type AppStateSnapshot, loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';
import { launchSprintBoundFlow } from '@src/application/ui/shared/launch/sprint-bound.ts';
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
  const deps = useDeps();
  const ui = useUiState();
  const selection = useSelection();
  const sessions = useSessionManager();
  const queue = usePromptQueue();
  const storage = useStorage();

  const { state } = useAsyncLoad<AppStateSnapshot>(
    () =>
      loadAppStateSnapshot(
        { projectRepo: deps.projectRepo, sprintRepo: deps.sprintRepo, taskRepo: deps.taskRepo },
        {
          ...(selection.projectId !== undefined ? { projectId: selection.projectId } : {}),
          ...(selection.sprintId !== undefined ? { sprintId: selection.sprintId } : {}),
        }
      ),
    [selection.projectId, selection.sprintId]
  );

  const snapshot = state.kind === 'ok' ? state.value : undefined;
  const hasProject = snapshot?.project !== undefined;
  const currentSprint = snapshot?.sprint;
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
  // before the freshness check resolves to "stale".
  const lastSwitch = selection.lastSwitch;
  useEffect(() => {
    if (lastSwitch === undefined) return undefined;
    const elapsed = Date.now() - lastSwitch.at;
    const remaining = SWITCH_FEEDBACK_MS - elapsed;
    if (remaining <= 0) return undefined;
    const id = setTimeout(() => {
      // Re-render via a no-op state churn. The render itself reads the freshness window —
      // there's nothing to flip on this side beyond forcing a paint.
      setLocalError((curr) => curr);
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
  const launchCreateSprint = useCallback(async (): Promise<void> => {
    if (selection.projectId === undefined) {
      flashErr('✗ pick a project first (Projects → open one)');
      return;
    }
    const snap = await loadAppStateSnapshot(
      { projectRepo: deps.projectRepo, sprintRepo: deps.sprintRepo, taskRepo: deps.taskRepo },
      { projectId: selection.projectId }
    );
    const interactive = createInkInteractivePrompt(queue);
    const result = await launchSprintBoundFlow(
      { app: deps, interactive, storage, runInTerminal: getRunInTerminal() },
      'create-sprint',
      snap,
      {
        onReseat: ({ id, name }) => {
          selection.setSprint(id, name);
        },
        onSprintResolved: (runnerId, { id, name }) => {
          sessions.setPinnedSprint(runnerId, id, name);
        },
      }
    );
    if (!result.ok) {
      flashErr(`✗ ${result.reason}`);
      return;
    }
    sessions.register({
      runner: result.runner,
      flowId: 'create-sprint',
      title: result.title,
      ...sessionHintsFromLaunchResult(result),
    });
    void result.runner.start();
    router.push({ id: 'execute', props: { sessionId: result.runner.id } });
  }, [deps, queue, storage, sessions, router, selection, flashErr]);

  // Inline-shortcut + `+` hotkey. We watch for `+` outside the ActionMenu's hotkey machinery
  // because `+` is shift-bound on many keyboards (not portable as a registered MenuItem hotkey
  // glyph). Gating on `hasProject` matches the menu-row `disabledReason` semantics so both
  // entry points behave identically.
  useInput(
    (input) => {
      if (ui.helpOpen || ui.promptActive) return;
      if (input !== '+') return;
      if (!hasProject) {
        flashErr('✗ pick a project first (Projects → open one)');
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
          <StateCard state={state.kind === 'ok' ? state.value : undefined} loading={state.kind === 'loading'} />
          {switchToastVisible && lastSwitch !== undefined && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Text color={inkColors.success}>{`✓ now on ${lastSwitch.sprintLabel}`}</Text>
            </Box>
          )}
          {localError !== undefined && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Text color={inkColors.error}>{localError}</Text>
            </Box>
          )}
          <Box marginY={spacing.section}>
            <ActionMenu items={items} active={!ui.promptActive} initialIndex={initialMenuIndex} />
          </Box>
        </Box>
      )}
    </ViewShell>
  );
};
