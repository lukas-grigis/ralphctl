/**
 * ReplView — Ink REPL root.
 *
 * Shows the banner, live sprint dashboard header, and a context-aware action
 * menu built from the pure helpers in `menu-builder.ts`. Picking an action
 * runs the matching command function from `command-map.ts` inline: the command
 * renders its own prompts through `getPrompt()`, which routes to
 * `<PromptHost />` at the root. When the command finishes, the menu re-renders
 * with refreshed context so disabled states and the suggested next action
 * update.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { MenuContext, MenuItem, SubMenu } from '@src/integration/ui/tui/views/menu-builder.ts';
import { buildMainMenu, buildSubMenu, isWorkflowAction } from '@src/integration/ui/tui/views/menu-builder.ts';
import { type DashboardData, getNextAction } from '@src/integration/ui/tui/views/dashboard-data.ts';
import { getAiProvider, getConfig } from '@src/integration/persistence/config.ts';
import { getSprint } from '@src/integration/persistence/sprint.ts';
import { listProjects } from '@src/integration/persistence/project.ts';
import { allRequirementsApproved, getPendingRequirements } from '@src/integration/persistence/ticket.ts';
import { type Tasks, TasksSchema } from '@src/domain/models.ts';
import { getTasksFilePath } from '@src/integration/persistence/paths.ts';
import { readValidatedJson } from '@src/integration/persistence/storage.ts';
import { Banner } from '@src/integration/ui/tui/components/banner.tsx';
import { DashboardHeader } from '@src/integration/ui/tui/components/dashboard-header.tsx';
import { ActionMenu } from '@src/integration/ui/tui/components/action-menu.tsx';
import { StatusBar } from '@src/integration/ui/tui/components/status-bar.tsx';
import { SettingsPanel } from './settings-panel.tsx';
import { commandMap } from './command-map.ts';

interface ReplState {
  ctx: MenuContext;
  dashboardData: DashboardData | null;
}

async function readTasksSafe(sprintId: string): Promise<Tasks> {
  const result = await readValidatedJson(getTasksFilePath(sprintId), TasksSchema);
  return result.ok ? result.value : [];
}

async function loadReplState(): Promise<ReplState> {
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
  if (!sprintId) return { ctx, dashboardData: null };

  ctx.currentSprintId = sprintId;
  const [sprint, tasks] = await Promise.all([getSprint(sprintId).catch(() => null), readTasksSafe(sprintId)]);
  if (!sprint) return { ctx, dashboardData: null };

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

  return { ctx, dashboardData };
}

type Mode = 'main' | { kind: 'sub'; menu: SubMenu; group: string } | 'busy' | 'settings';

export function ReplView(): React.JSX.Element {
  const app = useApp();
  const [state, setState] = useState<ReplState | null>(null);
  const [mode, setMode] = useState<Mode>('main');
  const [error, setError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState('');
  const [refreshCounter, setRefreshCounter] = useState(0);

  const refresh = useCallback((): void => {
    setRefreshCounter((n) => n + 1);
  }, []);

  // Reload context whenever refreshCounter bumps.
  useEffect(() => {
    const cancel = { current: false };
    const load = async (): Promise<void> => {
      try {
        const next = await loadReplState();
        if (!cancel.current) setState(next);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancel.current = true;
    };
  }, [refreshCounter]);

  // Global hotkeys — only apply when not in the middle of a menu/command.
  useInput((input, key) => {
    if (mode === 'busy') return;
    if (mode === 'settings') return;
    if (input === 's') {
      setMode('settings');
      return;
    }
    if (input === 'q' && mode === 'main') {
      app.exit();
      return;
    }
    if (key.escape && typeof mode === 'object') {
      setMode('main');
    }
  });

  const runHandler = useCallback(
    async (group: string, subCommand: string): Promise<void> => {
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
    [refresh]
  );

  const onMainSelect = useCallback(
    (value: string): void => {
      if (value === 'exit') {
        app.exit();
        return;
      }
      if (value.startsWith('action:')) {
        const parts = value.split(':');
        void runHandler(parts[1] ?? '', parts[2] ?? '');
        return;
      }
      if (!state) return;
      const sub = buildSubMenu(value, state.ctx);
      if (sub) setMode({ kind: 'sub', menu: sub, group: value });
    },
    [state, runHandler, app]
  );

  const onSubSelect = useCallback(
    (value: string): void => {
      if (typeof mode !== 'object') return;
      if (value === 'back') {
        setMode('main');
        return;
      }
      const group = mode.group;
      const runAndRefresh = async (): Promise<void> => {
        await runHandler(group, value);
        // Workflow actions return to main; others stay in submenu with refreshed ctx.
        if (!isWorkflowAction(group, value) && state) {
          const next = buildSubMenu(group, state.ctx);
          if (next) setMode({ kind: 'sub', menu: next, group });
        }
      };
      void runAndRefresh();
    },
    [mode, runHandler, state]
  );

  // Main render
  if (state === null) {
    return (
      <Box>
        <Text dimColor>Loading…</Text>
      </Box>
    );
  }

  const hints: { key: string; action: string }[] = [
    { key: 's', action: 'settings' },
    ...(mode === 'main' ? [{ key: 'q', action: 'quit' }] : []),
    ...(typeof mode === 'object' ? [{ key: 'esc', action: 'back' }] : []),
  ];

  const { items: mainItems, defaultValue } = buildMainMenu(state.ctx);

  return (
    <Box flexDirection="column">
      <Banner />
      <Box marginTop={1}>
        <DashboardHeader data={state.dashboardData} />
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        {mode === 'busy' ? (
          <Text dimColor>Running {busyLabel}…</Text>
        ) : mode === 'settings' ? (
          <SettingsPanel
            onClose={() => {
              setMode('main');
              refresh();
            }}
          />
        ) : mode === 'main' ? (
          <ActionMenu
            items={mainItems}
            defaultValue={defaultValue}
            onSelect={onMainSelect}
            onCancel={() => {
              app.exit();
            }}
          />
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

      <Box marginTop={1}>
        <StatusBar hints={hints} />
      </Box>
    </Box>
  );
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
      <Box>
        <Text bold>{menu.title}</Text>
      </Box>
      <ActionMenu items={menu.items as readonly MenuItem[]} onSelect={onSelect} onCancel={onCancel} />
    </Box>
  );
}
