/**
 * HomeView — the pipeline map is the spine of Home.
 *
 * Home renders the sprint lifecycle as four phases (Refine / Plan / Execute /
 * Close) with a bright "Next step" quick action anchored above. Everything
 * else — browsing entities, editing configuration, running the doctor — is
 * behind a single `b` hotkey that opens a secondary submenu. Settings and
 * Dashboard remain router destinations reachable via the existing `s` / `d`
 * hotkeys owned by `view-router.tsx`.
 *
 * State shape:
 *   - `mode: 'main'` → pipeline map is focused
 *   - `mode: { kind: 'sub', menu, group }` → a submenu is focused (opened via
 *     `b`, or transitioned into from the browse menu)
 *   - `mode: 'busy'` → a command is running; no input
 *
 * Submenu entries use two prefixes:
 *   - `action:<group>:<sub>` — dispatch the matching command directly
 *   - `group:<name>`         — transition into that group's submenu
 *
 * Pipeline-map actions are always `action:<group>:<sub>` since the map never
 * needs to open a submenu to advance the sprint.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { MenuContext, MenuItem, SubMenu } from '@src/integration/ui/tui/views/menu-builder.ts';
import { buildSubMenu } from '@src/integration/ui/tui/views/menu-builder.ts';
import {
  computePipelineSnapshot,
  type PhaseAction,
  type PhaseId,
  type PipelineSnapshot,
} from '@src/integration/ui/tui/views/pipeline-phases.ts';
import type { ViewEntry } from './router-context.ts';
import { type DashboardData, getNextAction } from '@src/integration/ui/tui/views/dashboard-data.ts';
import { getAiProvider, getConfig } from '@src/integration/persistence/config.ts';
import { getSprint } from '@src/integration/persistence/sprint.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { allRequirementsApproved, getPendingRequirements } from '@src/integration/persistence/ticket.ts';
import { type Tasks, TasksSchema } from '@src/domain/models.ts';
import { getTasksFilePath } from '@src/integration/persistence/paths.ts';
import { readValidatedJson } from '@src/integration/persistence/storage.ts';
import { SprintSummaryLine } from '@src/integration/ui/tui/components/sprint-summary-line.tsx';
import { ActionMenu } from '@src/integration/ui/tui/components/action-menu.tsx';
import { PipelineMap } from '@src/integration/ui/tui/components/pipeline-map.tsx';
import { SectionStamp } from '@src/integration/ui/tui/components/section-stamp.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter, type ViewId } from './router-context.ts';
import { commandMap } from './command-map.ts';

// `b browse` lives in the global footer (view-router.tsx) so the browse
// affordance sits next to the other global shortcuts (settings / dashboard /
// doctor / quit). View-local hints only advertise selection mechanics.
const HOME_HINTS_MAIN = [
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'select' },
] as const;

const HOME_HINTS_SUB = [
  { key: '↑/↓', action: 'move' },
  { key: 'Enter', action: 'select' },
  { key: 'Esc', action: 'back' },
] as const;

const HOME_HINTS_NONE = [] as const;

/**
 * Workflow actions that have native Ink views. Takes precedence over
 * `commandMap` — matching actions `router.push` instead of shelling out to
 * the plain-CLI command so their output doesn't corrupt the alt-screen.
 *
 * Extend this table as milestones migrate more CLI commands to native views.
 */
const WORKFLOW_VIEWS: Record<string, Record<string, ViewId>> = {
  sprint: {
    create: 'sprint-create',
    delete: 'sprint-delete',
    current: 'sprint-set-current',
    requirements: 'sprint-requirements-export',
    context: 'sprint-context-export',
    ideate: 'ideate',
    'progress log': 'progress-log',
    'progress show': 'progress-show',
  },
  ticket: {
    add: 'ticket-add',
    edit: 'ticket-edit',
    remove: 'ticket-remove',
    refine: 'ticket-refine',
  },
  task: {
    add: 'task-add',
    import: 'task-import',
    status: 'task-status',
    reorder: 'task-reorder',
    remove: 'task-remove',
    next: 'task-next',
  },
  project: {
    add: 'project-add',
    remove: 'project-remove',
    'repo add': 'project-repo-add',
    'repo remove': 'project-repo-remove',
    edit: 'project-edit',
    onboard: 'project-onboard',
  },
  progress: {
    log: 'progress-log',
    show: 'progress-show',
  },
  doctor: {
    run: 'doctor',
  },
};

/**
 * Browse actions (list/show) map to router views by group. These do *not*
 * need per-action keys the way `WORKFLOW_VIEWS` does, because the submenu's
 * value is `list` / `show` and we translate it 1:1 to `<group>-list` /
 * `<group>-show`.
 */
const BROWSE_VIEWS: Record<string, Record<'list' | 'show', ViewId>> = {
  sprint: { list: 'sprint-list', show: 'sprint-show' },
  ticket: { list: 'ticket-list', show: 'ticket-show' },
  task: { list: 'task-list', show: 'task-show' },
  project: { list: 'project-list', show: 'project-show' },
};

/**
 * Sprint lifecycle quick-actions map to the same phase views used by drill-in.
 * Without this mapping, these actions would fall through to `commandMap` and
 * shell out to the plain-CLI command — which writes to stdout and garbles the
 * alt-screen buffer. Routing through `PHASE_VIEWS` keeps everything native.
 */
const PHASE_VIEWS: Record<'sprint', Record<string, PhaseId>> = {
  sprint: { refine: 'refine', plan: 'plan', start: 'execute', close: 'close' },
};

interface ReplState {
  ctx: MenuContext;
  dashboardData: DashboardData | null;
  snapshot: PipelineSnapshot;
}

async function readTasksSafe(sprintId: string): Promise<Tasks> {
  const result = await readValidatedJson(getTasksFilePath(sprintId), TasksSchema);
  return result.ok ? result.value : [];
}

async function loadHomeState(): Promise<ReplState> {
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
    nextAction: null,
    aiProvider: null,
  };

  const [config, projects] = await Promise.all([getConfig().catch(() => null), listProjects().catch(() => [])]);
  ctx.hasProjects = projects.length > 0;
  ctx.projectCount = projects.length;
  ctx.aiProvider = (await getAiProvider().catch(() => null)) ?? config?.aiProvider ?? null;

  const sprintId = config?.currentSprint ?? null;
  if (!sprintId) {
    return { ctx, dashboardData: null, snapshot: computePipelineSnapshot(ctx) };
  }

  ctx.currentSprintId = sprintId;
  const [sprint, tasks] = await Promise.all([getSprint(sprintId).catch(() => null), readTasksSafe(sprintId)]);
  if (!sprint) {
    return { ctx, dashboardData: null, snapshot: computePipelineSnapshot(ctx) };
  }

  ctx.currentSprintName = sprint.name;
  ctx.currentSprintStatus = sprint.status;
  ctx.ticketCount = sprint.tickets.length;

  const pending = getPendingRequirements(sprint.tickets);
  ctx.pendingRequirements = pending.length;
  ctx.allRequirementsApproved = allRequirementsApproved(sprint.tickets);
  ctx.taskCount = tasks.length;
  ctx.tasksDone = tasks.filter((t) => t.status === 'done').length;
  ctx.tasksInProgress = tasks.filter((t) => t.status === 'in_progress').length;

  const ticketIdsWithTasks = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
  ctx.plannedTicketCount = sprint.tickets.filter((t) => ticketIdsWithTasks.has(t.id)).length;

  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const blockedCount = tasks.filter(
    (t) => t.status !== 'done' && t.blockedBy.length > 0 && !t.blockedBy.every((id) => doneIds.has(id))
  ).length;

  const dashboardData: DashboardData = {
    sprint,
    tasks,
    approvedCount: sprint.tickets.length - pending.length,
    pendingCount: pending.length,
    blockedCount,
    plannedTicketCount: ctx.plannedTicketCount,
    aiProvider: ctx.aiProvider,
  };
  ctx.nextAction = getNextAction(dashboardData);

  return { ctx, dashboardData, snapshot: computePipelineSnapshot(ctx) };
}

/** Internal HomeView modes — not router destinations. */
type Mode = 'main' | { kind: 'sub'; menu: SubMenu; group: string } | 'busy';

// Preserve the last submenu group across HomeView remounts (the router
// remounts views on push/pop). Without this, navigating away from a drill-in
// like Browse → Tickets and pressing Esc would land on Home's pipeline map
// instead of the Browse submenu the user came from.
let lastSubGroup: string | null = null;

/** Test-only: clear the persisted submenu so fixture runs start from main. */
export function __resetHomeModeMemory(): void {
  lastSubGroup = null;
}

export function HomeView(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<ReplState | null>(null);
  const [mode, setModeInternal] = useState<Mode>('main');
  const [error, setError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState('');
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Keep `lastSubGroup` in sync with mode so returning from a drill-in via
  // Esc lands the user back in the submenu they came from.
  const setMode = useCallback((next: Mode | ((prev: Mode) => Mode)): void => {
    setModeInternal((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      lastSubGroup = typeof resolved === 'object' ? resolved.group : null;
      return resolved;
    });
  }, []);

  const refresh = useCallback((): void => {
    setRefreshCounter((n) => n + 1);
  }, []);

  // Reload context whenever refreshCounter bumps. After the first load,
  // restore the submenu the user was in if they drilled in and came back.
  useEffect(() => {
    const cancel = { current: false };
    const load = async (): Promise<void> => {
      try {
        const next = await loadHomeState();
        if (cancel.current) return;
        setState(next);
        if (lastSubGroup !== null) {
          const menu = buildSubMenu(lastSubGroup, next.ctx);
          if (menu) setModeInternal({ kind: 'sub', menu, group: lastSubGroup });
        }
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancel.current = true;
    };
  }, [refreshCounter]);

  const runHandler = useCallback(
    async (group: string, subCommand: string): Promise<void> => {
      // Sprint lifecycle quick-actions (refine/plan/start/close) route through
      // the same phase views used for drill-in. Without this, they'd shell out
      // to the plain-CLI command and garble the alt-screen frame with printHeader
      // output landing above the fixed banner.
      const phaseId = group === 'sprint' ? PHASE_VIEWS.sprint[subCommand] : undefined;
      if (phaseId !== undefined) {
        if (state?.ctx.currentSprintId == null) {
          setError('No current sprint set.');
          return;
        }
        const entry = resolveDrillInTarget(phaseId, state.ctx.currentSprintId, state.snapshot);
        if (entry === null) {
          setError(`Cannot open ${subCommand} phase right now.`);
          return;
        }
        router.push(entry);
        return;
      }
      // Prefer native Ink views — takes precedence over the plain-CLI shell-out
      // so workflow commands render inside the alt-screen buffer.
      const viewId = WORKFLOW_VIEWS[group]?.[subCommand];
      if (viewId) {
        router.push({ id: viewId });
        return;
      }
      // Browse actions follow the `<group>-list` / `<group>-show` convention.
      if (subCommand === 'list' || subCommand === 'show') {
        const browseId = BROWSE_VIEWS[group]?.[subCommand];
        if (browseId) {
          router.push({ id: browseId });
          return;
        }
      }
      const handler = commandMap[group]?.[subCommand];
      if (!handler) {
        setError(`Unknown command: ${group} ${subCommand}`);
        return;
      }
      setMode('busy');
      setBusyLabel(`${group} ${subCommand}`);
      setError(null);
      try {
        await handler();
      } catch (err) {
        if (err instanceof Error && err.name !== 'PromptCancelledError') {
          setError(err.message);
        }
      } finally {
        setMode('main');
        refresh();
      }
    },
    [refresh, router, state]
  );

  // Hotkeys owned by Home itself. Global router hotkeys (h/s/d/q/esc) run in
  // parallel via `view-router.tsx`.
  useInput((input, key) => {
    if (mode === 'busy') return;
    // Esc inside a submenu drops back to the pipeline map. At root Home the
    // router handles Esc (no-op at stack root).
    if (key.escape && typeof mode === 'object') {
      setMode('main');
      return;
    }
    if (mode === 'main' && input === 'b' && state !== null) {
      const menu = buildSubMenu('browse', state.ctx);
      if (menu) setMode({ kind: 'sub', menu, group: 'browse' });
    }
  });

  const onPipelineAction = useCallback(
    (action: PhaseAction): void => {
      void runHandler(action.group, action.sub);
    },
    [runHandler]
  );

  /**
   * Drill-in dispatch for phase rows. Three of the four phases have their own
   * detail views; the Execute phase reuses the existing `execute` destination
   * because `ExecuteView` already has everything a dedicated execute-phase
   * view would otherwise duplicate.
   *
   * A phase drill-in only makes sense with a current sprint — we gate on
   * `currentSprintId`. Phases 2–4 also need the prerequisite to be satisfied
   * (e.g. tasks must exist before Execute can show anything meaningful); we
   * treat non-applicable drill-ins as no-ops so the user arrows back and
   * uses the quick action instead.
   */
  const onPipelineDrillIn = useCallback(
    (phaseId: PhaseId): void => {
      if (state === null) return;
      const sprintId = state.ctx.currentSprintId;
      if (sprintId === null) return;

      const entry = resolveDrillInTarget(phaseId, sprintId, state.snapshot);
      if (entry !== null) router.push(entry);
    },
    [router, state]
  );

  const onSubSelect = useCallback(
    (value: string): void => {
      if (typeof mode !== 'object') return;
      if (value === 'back') {
        setMode('main');
        return;
      }
      if (state === null) return;

      // `group:<name>` → transition into that group's submenu (no dispatch).
      if (value.startsWith('group:')) {
        const group = value.slice('group:'.length);
        const next = buildSubMenu(group, state.ctx);
        if (next) setMode({ kind: 'sub', menu: next, group });
        return;
      }

      // `action:<group>:<sub>` → dispatch directly.
      if (value.startsWith('action:')) {
        const parts = value.split(':');
        void runHandler(parts[1] ?? '', parts[2] ?? '');
        return;
      }

      // Bare `<subCommand>` → dispatch under the current submenu's group.
      const group = mode.group;
      void runHandler(group, value);
    },
    [mode, runHandler, state]
  );

  // Declare view-local hotkeys. The `b` hint only applies on the main pipeline
  // view; once a submenu is open the visible keys change. Busy state has no
  // view-local hints — global hotkeys still work. Stable refs: the hint
  // arrays are module-level constants so `useViewHints`'s effect doesn't
  // re-publish on every render.
  const activeHints = mode === 'main' ? HOME_HINTS_MAIN : typeof mode === 'object' ? HOME_HINTS_SUB : HOME_HINTS_NONE;
  useViewHints(activeHints);

  if (state === null) {
    return (
      <ViewShell bare>
        <Text dimColor>Loading…</Text>
      </ViewShell>
    );
  }

  return (
    <ViewShell bare>
      <Box paddingLeft={spacing.indent} flexDirection="column">
        {state.dashboardData ? (
          <Box marginTop={spacing.section}>
            <SprintSummaryLine data={state.dashboardData} />
          </Box>
        ) : null}

        {error ? (
          <Box marginTop={spacing.section}>
            <Text color={inkColors.error}>✗ {error}</Text>
          </Box>
        ) : null}

        <Box marginTop={spacing.section} flexDirection="column">
          {mode === 'busy' ? (
            <Text dimColor>Running {busyLabel}…</Text>
          ) : mode === 'main' ? (
            <PipelineMap snapshot={state.snapshot} onAction={onPipelineAction} onDrillIn={onPipelineDrillIn} />
          ) : (
            <SubMenuBlock
              menu={mode.menu}
              onSelect={onSubSelect}
              onCancel={() => {
                setMode('main');
              }}
            />
          )}
        </Box>
      </Box>
    </ViewShell>
  );
}

/**
 * Map a pipeline phase to a router destination for drill-in.
 *
 * - Refine / Plan / Close → their own phase detail views.
 * - Execute → the existing `execute` destination. Only routed when the
 *   phase status is `active` or `done`; pending phases have no meaningful
 *   detail view to show, so we no-op and let the user use the quick
 *   action (which runs the prepare flow) instead.
 */
function resolveDrillInTarget(phaseId: PhaseId, sprintId: string, snapshot: PipelineSnapshot): ViewEntry | null {
  switch (phaseId) {
    case 'refine':
      return { id: 'refine-phase', props: { sprintId } };
    case 'plan':
      return { id: 'plan-phase', props: { sprintId } };
    case 'execute': {
      const executePhase = snapshot.phases.find((p) => p.id === 'execute');
      if (!executePhase || executePhase.status === 'pending') return null;
      return { id: 'execute', props: { sprintId } };
    }
    case 'close':
      return { id: 'close-phase', props: { sprintId } };
    default: {
      const _exhaustive: never = phaseId;
      void _exhaustive;
      return null;
    }
  }
}

function SubMenuBlock({
  menu,
  onSelect,
  onCancel,
}: {
  menu: SubMenu;
  onSelect: (value: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <SectionStamp title={menu.title} />
      <Box marginTop={spacing.section}>
        <ActionMenu items={menu.items as readonly MenuItem[]} onSelect={onSelect} onCancel={onCancel} />
      </Box>
    </Box>
  );
}
