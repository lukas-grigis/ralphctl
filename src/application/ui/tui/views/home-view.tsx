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
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { ActionMenu, type MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { StatusChip, sprintStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { PipelineMap } from '@src/application/ui/tui/components/pipeline-map.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { loadAppStateSnapshot, type AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { createInkInteractivePrompt } from '@src/application/ui/tui/prompts/ink-interactive-prompt.ts';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { getRunInTerminal } from '@src/application/ui/tui/runtime/run-in-terminal.ts';
import { sessionHintsFromLaunchResult } from '@src/application/ui/shared/launcher.ts';
import { launchSprintBoundFlow } from '@src/application/ui/shared/launch/sprint-bound.ts';

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

  const items = useMemo<readonly MenuItem[]>(
    () => [
      ...(!hasProject && state.kind === 'ok'
        ? [
            {
              id: 'create-project',
              section: 'get started',
              label: 'Create your first project',
              description: 'Bind a repository to a project — required before any flow can run.',
              hotkey: 'c',
              onSelect: (): void => router.push({ id: 'create-project' }),
            } as MenuItem,
          ]
        : []),
      ...recentSprints.map(
        (s): MenuItem => ({
          id: `sprint-${String(s.id)}`,
          section: 'switch sprint',
          label: s.name,
          description:
            s.id === currentSprint?.id
              ? `(current) ${s.status} ${glyphs.bullet} ${String(s.tickets.length)} ticket${s.tickets.length === 1 ? '' : 's'}`
              : `${s.status} ${glyphs.bullet} ${String(s.tickets.length)} ticket${s.tickets.length === 1 ? '' : 's'}`,
          onSelect: (): void => {
            if (s.id === selection.sprintId) return;
            // `setSprint` updates `selection.lastSwitch`, which drives the transient toast
            // line above the menu — no separate flash call needed.
            selection.setSprint(s.id, s.name);
          },
        })
      ),
      // Create-new-sprint row sits in the same "switch sprint" section so it groups with the
      // inline shortcut list. Gated on `hasProject` — without one, the create flow has nothing
      // to target. The `+` hint mirrors the global hotkey we register in useInput above.
      ...(hasProject
        ? [
            {
              id: 'create-sprint',
              section: 'switch sprint',
              label: 'Create new sprint',
              description: 'Start a fresh sprint and select it as the current one.',
              hotkey: '+',
              globalHotkey: true,
              onSelect: (): void => {
                void launchCreateSprint();
              },
            } as MenuItem,
          ]
        : []),
      {
        id: 'flows',
        section: 'work',
        label: 'Start a flow',
        description: 'Pick from refine, plan, implement, readiness, and more.',
        hotkey: 'n',
        globalHotkey: true,
        onSelect: (): void => router.push({ id: 'flows' }),
      },
      {
        id: 'sprints',
        section: 'work',
        label: 'Sprints',
        description: 'Construct and run sprints — the main unit of work.',
        hotkey: 'r',
        onSelect: (): void => router.push({ id: 'sprints' }),
      },
      {
        id: 'pick-sprint',
        section: 'work',
        label: 'Switch sprint',
        description: 'Pick a different sprint — remembered for next launch.',
        hotkey: 'S',
        globalHotkey: true,
        ...(switchSprintDisabled !== undefined ? { disabledReason: switchSprintDisabled } : {}),
        onSelect: (): void => router.push({ id: 'pick-sprint' }),
      },
      {
        id: 'add-ticket',
        section: 'work',
        label: 'Add ticket',
        description: 'Append a pending ticket to the current sprint.',
        hotkey: 'a',
        ...(addTicketDisabled !== undefined ? { disabledReason: addTicketDisabled } : {}),
        onSelect: (): void => {
          if (selection.sprintId === undefined) return;
          router.push({ id: 'add-ticket', props: { sprintId: selection.sprintId } });
        },
      },
      {
        id: 'pick-project',
        section: 'work',
        label: 'Switch project',
        description: 'Pick a different project — remembered for next launch.',
        hotkey: 'P',
        globalHotkey: true,
        onSelect: (): void => router.push({ id: 'pick-project' }),
      },
      {
        id: 'projects',
        section: 'work',
        label: 'Projects',
        description: 'Browse projects and manage their repositories.',
        hotkey: 'p',
        onSelect: (): void => router.push({ id: 'projects' }),
      },
      {
        id: 'sessions',
        section: 'observe',
        label: 'Active sessions',
        description: 'Live and recent runs of any flow.',
        hotkey: 'x',
        globalHotkey: true,
        onSelect: (): void => router.push({ id: 'sessions' }),
      },
      {
        id: 'settings',
        section: 'system',
        label: 'Settings',
        description: 'AI provider, models, harness budgets.',
        hotkey: 's',
        globalHotkey: true,
        onSelect: (): void => router.push({ id: 'settings' }),
      },
      {
        id: 'doctor',
        section: 'system',
        label: 'Doctor',
        description: 'Sanity checks for paths, config, and runtime.',
        hotkey: '!',
        globalHotkey: true,
        onSelect: (): void => router.push({ id: 'doctor' }),
      },
    ],
    [
      router,
      hasProject,
      state.kind,
      switchSprintDisabled,
      addTicketDisabled,
      selection,
      recentSprints,
      currentSprint?.id,
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

/**
 * A short instruction line: "press <KEY> to <do thing>". Renders the key in highlight, the
 * label in plain text. Used by every regime of StateCard to make the next action obvious.
 */
const KeyCue = ({ keys, label }: { readonly keys: string; readonly label: string }): React.JSX.Element => (
  <Text>
    <Text dimColor>{glyphs.bullet} press </Text>
    <Text bold color={inkColors.highlight}>
      {keys}
    </Text>
    <Text dimColor> to </Text>
    <Text>{label}</Text>
  </Text>
);

/**
 * A one-liner explaining how the app is laid out — visible only when the user hasn't yet
 * created a sprint. Once they're in the flow it stays out of the way.
 */
const OrientationLine = (): React.JSX.Element => (
  <Box marginTop={1}>
    <Text dimColor italic>
      Workflow: project {glyphs.arrowRight} sprint {glyphs.arrowRight} tickets {glyphs.arrowRight} refine{' '}
      {glyphs.arrowRight} plan {glyphs.arrowRight} implement {glyphs.arrowRight} PR
    </Text>
  </Box>
);

/**
 * Phase-aware "next action" hint for a loaded sprint — mirrors the one on sprint-detail so
 * the user sees the same recommendation regardless of where they look.
 */
const sprintNextActionLabel = (snapshot: AppStateSnapshot): string | undefined => {
  const sprint = snapshot.sprint;
  if (sprint === undefined) return undefined;
  const { pendingTicketCount, approvedTicketCount, resumableTaskCount } = snapshot.triggerInputs;
  switch (sprint.status) {
    case 'draft':
      if (sprint.tickets.length === 0) return 'add tickets — open the sprint and press a';
      if (pendingTicketCount > 0) return `refine ${String(pendingTicketCount)} pending ticket(s) — press n`;
      if (approvedTicketCount > 0) return `plan ${String(approvedTicketCount)} approved ticket(s) — press n`;
      return undefined;
    case 'planned':
    case 'active':
      if (resumableTaskCount > 0) return `implement ${String(resumableTaskCount)} pending task(s) — press n`;
      return 'review the sprint — open it for the task list';
    case 'review':
      return 'open a pull request — press n → create-pr';
    case 'done':
      return undefined;
  }
};

/**
 * Three states, three layouts:
 *   - no project           → big empty state with "create your first project" CTA
 *   - project, no sprint   → ready-to-start-a-sprint card with a single prominent CTA
 *   - project + sprint     → sprint-centric overview: name + status + counts + pipeline
 *
 * The point: when the user lands on home, the most relevant action should be the visual
 * focus. A dense FieldList of project / repo / ticket metadata buries that action.
 */
const StateCard = ({
  state,
  loading,
}: {
  readonly state: AppStateSnapshot | undefined;
  readonly loading: boolean;
}): React.JSX.Element => {
  if (loading) {
    return (
      <Box paddingX={spacing.indent}>
        <Spinner label="loading state…" />
      </Box>
    );
  }
  if (!state) return <Box />;

  if (state.projectCount === 0) {
    return (
      <Card title="▸ Start by creating a project" tone="primary">
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            A project binds one or more repositories together. Sprints, tickets, and runs all live inside one.
          </Text>
          <Box marginTop={1}>
            <KeyCue keys="c" label="create your first project" />
          </Box>
          <OrientationLine />
        </Box>
      </Card>
    );
  }

  if (!state.project) {
    return (
      <Card title="▸ Pick a project to work on" tone="primary">
        <Box flexDirection="column" paddingX={spacing.indent}>
          <Text>
            <Text bold>{String(state.projectCount)}</Text>
            <Text dimColor> project{state.projectCount === 1 ? '' : 's'} in storage.</Text>
          </Text>
          <Box marginTop={1}>
            <KeyCue keys="p" label="open Projects and select one" />
          </Box>
        </Box>
      </Card>
    );
  }

  const sprint = state.sprint;
  const sprintCount = state.sprintCount;

  if (!sprint) {
    const title = `▸ ${state.project.displayName} — ${sprintCount === 0 ? 'ready for the first sprint' : 'pick or create a sprint'}`;
    return (
      <Card title={title} tone="primary">
        <Box flexDirection="column" paddingX={spacing.indent}>
          {sprintCount === 0 ? (
            <Text>Sprints are the unit of work. Refine, plan, and implement all target one.</Text>
          ) : (
            <Text>
              <Text bold>{String(sprintCount)}</Text>
              <Text dimColor> sprint{sprintCount === 1 ? '' : 's'} in this project — pick one to continue.</Text>
            </Text>
          )}
          <Box marginTop={1}>
            <KeyCue
              keys="r"
              label={
                sprintCount === 0 ? 'open Sprints and press c to create one' : 'open Sprints to pick or create one'
              }
            />
          </Box>
          {sprintCount === 0 && <OrientationLine />}
        </Box>
      </Card>
    );
  }

  const nextAction = sprintNextActionLabel(state);
  return (
    <Card
      title={`▸ ${sprint.name}`}
      tone="primary"
      right={<StatusChip label={sprint.status} kind={sprintStatusKind(sprint.status)} />}
    >
      <Box flexDirection="column" paddingX={spacing.indent}>
        <Box>
          <Text dimColor>
            {state.project.displayName} {glyphs.bullet} {String(state.project.repositories.length)} repo
            {state.project.repositories.length === 1 ? '' : 's'}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text>
            <Text bold>{String(sprint.tickets.length)}</Text>
            <Text dimColor> tickets </Text>
            <Text bold color={inkColors.warning}>
              {String(state.triggerInputs.pendingTicketCount)}
            </Text>
            <Text dimColor> pending </Text>
            <Text bold color={inkColors.success}>
              {String(state.triggerInputs.approvedTicketCount)}
            </Text>
            <Text dimColor> approved {glyphs.bullet} </Text>
            <Text bold>{String(state.triggerInputs.resumableTaskCount)}</Text>
            <Text dimColor> tasks pending</Text>
          </Text>
        </Box>
        <Box marginTop={1}>
          <PipelineMap status={sprint.status} />
        </Box>
        {nextAction !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>{glyphs.bullet} next: </Text>
            <Text bold color={inkColors.highlight}>
              {nextAction}
            </Text>
          </Box>
        )}
      </Box>
    </Card>
  );
};
