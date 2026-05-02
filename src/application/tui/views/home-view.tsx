/**
 * HomeView — the pipeline map is the spine of Home.
 *
 * Layout:
 *   SprintSummaryLine  (current sprint, or "No current sprint")
 *   PipelineMap        (bright Next-step row + 4 phase rows)
 *   [SubMenu]          (visible only in 'sub' mode)
 *   [Spinner]          (visible only in 'busy' mode)
 *
 * Internal modes:
 *   'main'                   → pipeline map is focused
 *   { kind:'sub', ... }      → a submenu is focused; Esc returns to main
 *   'busy'                   → a command is launching; spinner; no input
 *
 * Dispatch:
 *   Submenus + the pipeline map both yield a typed `MenuAction`. The
 *   single `dispatch()` switch routes by `action.kind`:
 *     - `route`        → router.push(viewId)
 *     - `subMenu`      → enter the matching submenu
 *     - `launchChain`  → start the chain via `launchWorkflow` and push 'execute'
 *     - `back`         → return to main mode
 *   The discriminator is exhaustive — adding a kind requires adding an arm.
 *
 * Global hotkeys (Esc / h / s / d / x / ? / q) are owned by `useGlobalKeys`
 * and `view-router.tsx` — this view adds only the `b` browse hotkey.
 *
 * All key lookups go through `getKeyFor(action)` — no hard-coded letters.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box } from 'ink';
import { useViewInput } from './use-view-input.ts';
import { spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import { SectionStamp } from '@src/application/tui/components/section-stamp.tsx';
import { PipelineMap } from '@src/application/tui/components/pipeline-map.tsx';
import { ActionMenu } from '@src/application/tui/components/action-menu.tsx';
import { SprintSummaryLine, type SprintSummaryData } from '@src/application/tui/components/sprint-summary-line.tsx';
import { useViewHints } from './view-hints-context.tsx';
import { useRouter } from './router-context.ts';
import { getKeyFor } from '@src/application/tui/keyboard-map.ts';
import { buildSubMenu, type MenuContext, type SubMenu } from './menu-builder.ts';
import { getHomeSubmenuMemory, setHomeSubmenuMemory } from './home-submenu-memory.ts';
import {
  computePipelineSnapshot,
  type PhaseAction,
  type PhaseId,
  type PipelineSnapshot,
} from '@src/application/tui/pipeline-phases.ts';
import type { SessionManagerPort } from '@src/application/runtime/session-manager-port.ts';
import { getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { ShowSprintUseCase } from '@src/business/usecases/sprint/show-sprint.ts';
import { ListTasksUseCase } from '@src/business/usecases/task/list-tasks.ts';
import type { ViewEntry } from './router-context.ts';
import type { MenuAction, MenuGroup } from './menu-action.ts';
import { launchWorkflow } from './launch-workflow.ts';

// ── Mode ──────────────────────────────────────────────────────────────────────

type Mode = 'main' | { readonly kind: 'sub'; readonly menu: SubMenu; readonly group: MenuGroup } | 'busy';

// ── Hint sets (stable module-level constants to avoid re-publish on every render) ─

const HINTS_MAIN = [
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'select' },
  { key: getKeyFor('home.browse'), action: 'browse' },
] as const;

const HINTS_SUB = [
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'select' },
  { key: 'Esc', action: 'back' },
] as const;

const HINTS_BUSY: readonly never[] = [];

// ── Loading helpers ───────────────────────────────────────────────────────────

interface HomeSnapshot {
  readonly ctx: MenuContext;
  readonly summaryData: SprintSummaryData | null;
  readonly snapshot: PipelineSnapshot;
}

async function loadHomeSnapshot(): Promise<HomeSnapshot> {
  const deps = await getSharedDeps();
  const config = await deps.configStore.load();
  if (!config.ok) {
    const ctx: MenuContext = {
      hasProjects: false,
      projectCount: 0,
      currentSprintId: null,
      currentSprintName: null,
      currentSprintStatus: null,
      ticketCount: 0,
      taskCount: 0,
      tasksDone: 0,
      tasksInProgress: 0,
      pendingRequirements: 0,
      allRequirementsApproved: false,
      plannedTicketCount: 0,
      aiProvider: null,
      currentSprintHasBranch: false,
      currentSprintHasPullRequest: false,
    };
    return { ctx, summaryData: null, snapshot: computePipelineSnapshot(ctx) };
  }

  const projectsResult = await deps.projectRepo.list();
  const projects = projectsResult.ok ? projectsResult.value : [];

  const sprintIdStr = config.value.currentSprint;
  const parsedSprintId = sprintIdStr ? SprintId.parse(sprintIdStr) : null;
  const sprintId = parsedSprintId?.ok ? parsedSprintId.value : null;

  const ctx: MenuContext = {
    hasProjects: projects.length > 0,
    projectCount: projects.length,
    currentSprintId: sprintId,
    currentSprintName: null,
    currentSprintStatus: null,
    ticketCount: 0,
    taskCount: 0,
    tasksDone: 0,
    tasksInProgress: 0,
    pendingRequirements: 0,
    allRequirementsApproved: false,
    plannedTicketCount: 0,
    aiProvider: config.value.aiProvider,
    currentSprintHasBranch: false,
    currentSprintHasPullRequest: false,
  };

  if (!sprintId) {
    return { ctx, summaryData: null, snapshot: computePipelineSnapshot(ctx) };
  }

  const [sprintResult, tasksResult] = await Promise.all([
    new ShowSprintUseCase(deps.sprintRepo).execute({ id: sprintId }),
    new ListTasksUseCase(deps.taskRepo).execute({ sprintId }),
  ]);

  if (!sprintResult.ok) {
    return { ctx, summaryData: null, snapshot: computePipelineSnapshot(ctx) };
  }

  const sprint = sprintResult.value;
  const tasks = tasksResult.ok ? tasksResult.value : [];

  const tasksDone = tasks.filter((t) => t.status === 'done').length;
  const tasksInProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const pendingReqs = sprint.tickets.filter((t) => t.requirementStatus === 'pending').length;
  const allApproved = sprint.tickets.length > 0 && pendingReqs === 0;
  const ticketIdsWithTasks = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
  const plannedTicketCount = sprint.tickets.filter((t) => ticketIdsWithTasks.has(t.id)).length;

  const ctxFilled: MenuContext = {
    ...ctx,
    currentSprintId: sprintId,
    currentSprintName: sprint.name,
    currentSprintStatus: sprint.status,
    ticketCount: sprint.tickets.length,
    taskCount: tasks.length,
    tasksDone,
    tasksInProgress,
    pendingRequirements: pendingReqs,
    allRequirementsApproved: allApproved,
    plannedTicketCount,
    currentSprintHasBranch: sprint.branch !== null,
    currentSprintHasPullRequest: sprint.pullRequestUrl !== null,
  };

  const summaryData: SprintSummaryData = {
    name: sprint.name,
    status: sprint.status,
    ticketCount: sprint.tickets.length,
    taskCount: tasks.length,
    tasksDone,
    branch: sprint.branch,
  };

  return {
    ctx: ctxFilled,
    summaryData,
    snapshot: computePipelineSnapshot(ctxFilled),
  };
}

// ── Phase drill-in resolution ─────────────────────────────────────────────────

function resolveDrillIn(phaseId: PhaseId, sprintId: string, snapshot: PipelineSnapshot): ViewEntry | null {
  switch (phaseId) {
    case 'refine':
      return null; // no dedicated refine-phase view yet — use pipeline map action
    case 'plan':
      return null; // no dedicated plan-phase view yet
    case 'execute': {
      const phase = snapshot.phases.find((p) => p.id === 'execute');
      if (!phase || phase.status === 'pending') return null;
      return { id: 'execute', props: { sprintId } };
    }
    case 'close':
      return { id: 'sprint-close' };
    default: {
      const _exhaustive: never = phaseId;
      void _exhaustive;
      return null;
    }
  }
}

// ── SubMenuBlock sub-component ────────────────────────────────────────────────

function SubMenuBlock({
  menu,
  onSelect,
  onCancel,
}: {
  readonly menu: SubMenu;
  readonly onSelect: (action: MenuAction) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <SectionStamp title={menu.title.toUpperCase()} />
      <Box marginTop={spacing.section}>
        <ActionMenu items={menu.items} onSelect={onSelect} onCancel={onCancel} />
      </Box>
    </Box>
  );
}

// ── HomeView ──────────────────────────────────────────────────────────────────

interface Props {
  readonly sessionManager: SessionManagerPort | null;
}

export function HomeView({ sessionManager }: Props): React.JSX.Element {
  // Global hotkeys are installed once by GlobalKeyHandler in view-router.tsx —
  // installing them again here would double-fire every Esc / h / s / d / q
  // dispatch (and explain why menu actions could appear to launch twice).
  const router = useRouter();

  const [homeData, setHomeData] = useState<HomeSnapshot | null>(null);
  const [mode, setModeInternal] = useState<Mode>('main');
  const [error, setError] = useState<string | null>(null);

  // Keep submenu memory in sync with mode transitions.
  const setMode = useCallback((next: Mode | ((prev: Mode) => Mode)): void => {
    setModeInternal((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      setHomeSubmenuMemory(typeof resolved === 'object' ? resolved.group : null);
      return resolved;
    });
  }, []);

  // Refresh home snapshot. Used both on mount and whenever the session
  // manager fires a registry event (added / removed / active-changed) — a
  // proxy for "a task just finished or a session settled", so users
  // returning to home see fresh state without manual refresh.
  const refreshHome = useCallback(async (): Promise<HomeSnapshot | null> => {
    try {
      const data = await loadHomeSnapshot();
      setHomeData(data);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  // Load home data on mount.
  useEffect(() => {
    const guard = { cancelled: false };
    void (async () => {
      const data = await refreshHome();
      if (guard.cancelled || data === null) return;
      // Restore submenu memory after reload (e.g. user drills in and back).
      const stored = getHomeSubmenuMemory();
      if (stored !== null) {
        const menu = buildSubMenu(stored, data.ctx);
        setModeInternal({ kind: 'sub', menu, group: stored });
      }
    })();
    return () => {
      guard.cancelled = true;
    };
  }, [refreshHome]);

  // Re-fetch whenever the session registry changes — the dashboard already
  // uses this pattern as a "task-finished proxy" (see dashboard-view.tsx).
  useEffect(() => {
    if (sessionManager === null) return;
    const unsub = sessionManager.subscribe(() => {
      void refreshHome();
    });
    return unsub;
  }, [sessionManager, refreshHome]);

  // ── Action dispatch ──────────────────────────────────────────────────────────

  const dispatch = useCallback(
    (action: MenuAction): void => {
      setError(null);
      switch (action.kind) {
        case 'route':
          router.push({ id: action.viewId });
          return;
        case 'subMenu': {
          if (homeData === null) return;
          const menu = buildSubMenu(action.group, homeData.ctx);
          setMode({ kind: 'sub', menu, group: action.group });
          return;
        }
        case 'launchChain': {
          // Defer `router.push({ id: 'execute' })` until AFTER launchWorkflow
          // returns a sessionId. Pushing earlier mounts the execute view with
          // no explicit sessionId prop — its auto-attach picks the most
          // recent session in the registry, which after a previous run is
          // the COMPLETED one. The user then stares at the prior run's
          // terminal trace while answering pre-flight prompts for the new
          // run. By deferring the push, the user stays on home while the
          // prompts fire (InkPromptAdapter renders inline via PromptHost),
          // and execute mounts only once the new session exists.
          //
          // We deliberately do NOT call `setMode('main')` here — that would
          // clear the submenu memory, so when the chain settles and the user
          // pops execute, they'd land on the main pipeline-map instead of the
          // submenu they launched from (e.g. Projects > Onboard repo). The
          // user's expectation: come back to the same browse view.
          void (async () => {
            try {
              const deps = await getSharedDeps();
              // Snapshot pre-existing session ids BEFORE launchWorkflow so
              // we can detect when SessionManager dedup foregrounded an
              // existing run instead of starting a fresh one. The dedupe is
              // correct (single instance per sprint), but the user benefits
              // from a one-line breadcrumb in the execute view's
              // recent-events log.
              const preExisting = new Set(deps.sessionManager.list().map((d) => d.id));
              const sessionId = await launchWorkflow(action.flow, {
                deps,
                sessionManager: deps.sessionManager,
                router,
              });
              if (sessionId === null) {
                // User cancelled at a pre-flight prompt — stay on home, no
                // navigation. The submenu (if any) is preserved.
                return;
              }
              // Navigate AFTER the session exists so execute view's
              // auto-attach finds the new session, not the stale prior run.
              router.push({ id: 'execute' });
              if (sessionManager !== null) {
                if (preExisting.has(sessionId)) {
                  const existing = deps.sessionManager.get(sessionId);
                  deps.logger.info(`Foregrounded existing ${action.flow} session (${existing?.label ?? sessionId})`);
                }
                sessionManager.foreground(sessionId);
              }
            } catch (err) {
              // Home is still mounted (we haven't pushed yet), so surface
              // the error inline via setError — same UX as other dispatch
              // failures.
              setError(err instanceof Error ? err.message : String(err));
            }
          })();
          return;
        }
        case 'back':
          setMode('main');
          return;
      }
      const _exhaustive: never = action;
      void _exhaustive;
    },
    [homeData, router, sessionManager, setMode]
  );

  // ── Pipeline map callbacks ───────────────────────────────────────────────────

  const onPipelineAction = useCallback(
    (action: PhaseAction): void => {
      // PhaseAction is a MenuAction with an extra `label`. Dispatch handles it.
      dispatch(action);
    },
    [dispatch]
  );

  const onPipelineDrillIn = useCallback(
    (phaseId: PhaseId): void => {
      if (homeData === null) return;
      const sprintId = homeData.ctx.currentSprintId;
      if (sprintId === null) return;
      const entry = resolveDrillIn(phaseId, sprintId, homeData.snapshot);
      if (entry !== null) router.push(entry);
    },
    [homeData, router]
  );

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  const KEY_BROWSE = getKeyFor('home.browse');
  const KEY_HOME = getKeyFor('global.home');

  // useViewInput auto-suspends while a prompt owns the keyboard, so view
  // shortcuts can't shadow keystrokes the user is typing into a prompt.
  useViewInput((input, key) => {
    if (mode === 'busy') return;

    // Esc inside a submenu returns to pipeline map.
    if (key.escape && typeof mode === 'object') {
      setMode('main');
      return;
    }

    // `h` in a submenu closes it (router Esc/h would also work but this is cheaper).
    if (input === KEY_HOME && typeof mode === 'object') {
      setMode('main');
      return;
    }

    // `b` opens the browse submenu from the pipeline map.
    if (mode === 'main' && input === KEY_BROWSE && homeData !== null) {
      const menu = buildSubMenu('browse', homeData.ctx);
      setMode({ kind: 'sub', menu, group: 'browse' });
    }
  });

  // ── Hints ────────────────────────────────────────────────────────────────────

  const activeHints = useMemo(() => {
    if (mode === 'busy') return HINTS_BUSY;
    if (typeof mode === 'object') return HINTS_SUB;
    return HINTS_MAIN;
  }, [mode]);

  useViewHints(activeHints);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (homeData === null) {
    return (
      <ViewShell bare>
        <Spinner label="Loading…" />
      </ViewShell>
    );
  }

  return (
    <ViewShell bare>
      <Box paddingLeft={spacing.indent} flexDirection="column">
        {/* Banner is now rendered by ViewShell on every view — eye anchor across navigation. */}

        {/* Sprint summary */}
        <Box>
          <SprintSummaryLine data={homeData.summaryData} />
        </Box>

        {/* Inline error */}
        {error !== null ? (
          <Box marginTop={spacing.section}>
            <ResultCard kind="error" title={error} />
          </Box>
        ) : null}

        {/* Main body: pipeline map / submenu / busy spinner */}
        <Box marginTop={spacing.section} flexDirection="column">
          {mode === 'busy' ? (
            <Spinner label="Running…" />
          ) : typeof mode === 'object' ? (
            <SubMenuBlock
              menu={mode.menu}
              onSelect={dispatch}
              onCancel={() => {
                setMode('main');
              }}
            />
          ) : (
            <PipelineMap snapshot={homeData.snapshot} onAction={onPipelineAction} onDrillIn={onPipelineDrillIn} />
          )}
        </Box>
      </Box>
    </ViewShell>
  );
}
