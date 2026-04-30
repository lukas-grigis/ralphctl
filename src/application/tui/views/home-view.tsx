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
import { Box, useInput } from 'ink';
import { spacing } from '../../../integration/ui/theme/tokens.ts';
import { ViewShell } from '../components/view-shell.tsx';
import { ResultCard } from '../components/result-card.tsx';
import { Spinner } from '../components/spinner.tsx';
import { SectionStamp } from '../components/section-stamp.tsx';
import { PipelineMap } from '../components/pipeline-map.tsx';
import { ActionMenu } from '../components/action-menu.tsx';
import { SprintSummaryLine, type SprintSummaryData } from '../components/sprint-summary-line.tsx';
import { useViewHints } from './view-hints-context.tsx';
import { useRouter } from './router-context.ts';
import { useGlobalKeys } from './use-global-keys.ts';
import { getKeyFor } from '../keyboard-map.ts';
import { buildSubMenu, type MenuContext, type SubMenu } from './menu-builder.ts';
import { clearHomeSubmenuMemory, getHomeSubmenuMemory, setHomeSubmenuMemory } from './home-submenu-memory.ts';
import { computePipelineSnapshot, type PhaseAction, type PhaseId, type PipelineSnapshot } from '../pipeline-phases.ts';
import type { SessionManagerPort } from '../../runtime/session-manager-port.ts';
import { getSharedDeps } from '../../bootstrap/get-shared-deps.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { ShowSprintUseCase } from '../../../business/usecases/sprint/show-sprint.ts';
import { ListTasksUseCase } from '../../../business/usecases/task/list-tasks.ts';
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

// ── Test-only reset ───────────────────────────────────────────────────────────

export function __resetHomeModeMemory(): void {
  clearHomeSubmenuMemory();
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
  const router = useRouter();
  useGlobalKeys(sessionManager);

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
          // Close any submenu before launching so the busy spinner is visible.
          setMode('main');
          void (async () => {
            try {
              const deps = await getSharedDeps();
              // start() flows through the shared-deps SessionManager (the
              // single registry of live sessions). The HomeView prop is the
              // dashboard handle — used only to foreground the new session.
              const sessionId = await launchWorkflow(action.flow, {
                deps,
                sessionManager: deps.sessionManager,
                router,
              });
              if (sessionId !== null && sessionManager !== null) {
                sessionManager.foreground(sessionId);
              }
              router.push({ id: 'execute' });
            } catch (err) {
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

  useInput((input, key) => {
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
