/**
 * ViewRouter — navigation stack for the Ink TUI.
 *
 * The router is the single source of truth for which view is on screen. It
 * owns the stack and exposes `{push, pop, replace, reset}` via React context.
 *
 * Global hotkeys dispatched by `useGlobalKeys()` (installed inside every
 * `ViewShell` and directly by `HomeView`):
 *   Esc   → pop one frame (no-op at root)
 *   h     → reset to [home]
 *   s     → push settings
 *   d     → push dashboard
 *   x     → push sessions (running runs)
 *   ?     → toggle help overlay
 *   !     → doctor (inert until doctor view is added)
 *   Tab   → cycle sessions (sessions switcher)
 *   q     → exit app (only from home root)
 *
 * The status bar at the bottom is the only persistent chrome — banners and
 * headers belong inside the views that need them.
 *
 * Help overlay (`?` key) is rendered above the active view when `isHelpOpen`
 * is true; it suspends the global-keys hook while open so keys don't bleed.
 *
 * All browse and CRUD views are wired. Sprint summary + workflow launch are
 * in HomeView.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box } from 'ink';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { PromptHost } from '@src/integration/ui/prompts/prompt-host.tsx';
import { KeyboardHints } from '@src/application/tui/components/keyboard-hints.tsx';
import { StatusBar } from '@src/application/tui/components/status-bar.tsx';
import { HelpOverlay } from '@src/application/tui/components/help-overlay.tsx';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { RouterProvider, type RouterApi, type ViewEntry, type ViewId } from './router-context.ts';
import { useGlobalKeys } from './use-global-keys.ts';
import { getCachedStack, setCachedStack } from '@src/application/tui/runtime/router-stack-cache.ts';
import { HomeView } from './home-view.tsx';
import { SettingsView } from './settings-view.tsx';
import { DashboardView } from './dashboard-view.tsx';
import { ExecuteView } from './execute-view.tsx';
import { SessionsView } from './sessions-view.tsx';
import { SprintListView } from './browse/sprint-list-view.tsx';
import { SprintShowView } from './browse/sprint-show-view.tsx';
import { TicketListView } from './browse/ticket-list-view.tsx';
import { ProjectListView } from './browse/project-list-view.tsx';
import { ProjectShowView } from './browse/project-show-view.tsx';
import { TaskListView } from './browse/task-list-view.tsx';
import { SprintCreateView } from './crud/sprint-create-view.tsx';
import { SprintEditView } from './crud/sprint-edit-view.tsx';
import { SprintSetCurrentView } from './crud/sprint-set-current-view.tsx';
import { SprintActivateView } from './crud/sprint-activate-view.tsx';
import { SprintCloseView } from './crud/sprint-close-view.tsx';
import { SprintRemoveView } from './crud/sprint-remove-view.tsx';
import { TicketAddView } from './crud/ticket-add-view.tsx';
import { TicketEditView } from './crud/ticket-edit-view.tsx';
import { TicketApproveView } from './crud/ticket-approve-view.tsx';
import { TicketRemoveView } from './crud/ticket-remove-view.tsx';
import { ProjectAddView } from './crud/project-add-view.tsx';
import { ProjectEditView } from './crud/project-edit-view.tsx';
import { ProjectRemoveView } from './crud/project-remove-view.tsx';
import { ProjectRepoAddView } from './crud/project-repo-add-view.tsx';
import { ProjectRepoRemoveView } from './crud/project-repo-remove-view.tsx';
import { TaskAddView } from './crud/task-add-view.tsx';
import { TaskEditView } from './crud/task-edit-view.tsx';
import { TaskEditStatusView } from './crud/task-edit-status-view.tsx';
import { TaskRemoveView } from './crud/task-remove-view.tsx';
import { DoctorView } from './doctor-view.tsx';
import { ProgressView } from './browse/progress-view.tsx';
import { SprintExportRequirementsView } from './crud/sprint-export-requirements-view.tsx';
import { SprintExportContextView } from './crud/sprint-export-context-view.tsx';
import type { SessionManagerPort, SessionDescriptor } from '@src/application/runtime/session-manager-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';

/**
 * The view registry. Adding a new top-level destination is one entry here +
 * one entry in `ViewId`. Each entry knows how to render its view from the
 * raw `props` bag on the stack frame.
 */
const views: Record<
  ViewId,
  {
    label: string;
    render(
      props: Readonly<Record<string, unknown>>,
      sessionManager: SessionManagerPort | null,
      signalBus: SignalBusPort | null
    ): React.JSX.Element;
  }
> = {
  home: {
    label: 'Home',
    render: (_props, sessionManager) => <HomeView sessionManager={sessionManager} />,
  },
  settings: {
    label: 'Settings',
    render: () => <SettingsView />,
  },
  dashboard: {
    label: 'Dashboard',
    render: (_props, sessionManager) => <DashboardView sessionManager={sessionManager} />,
  },
  execute: {
    label: 'Execute',
    render: (props, sessionManager, signalBus) => {
      const sessionId = typeof props['sessionId'] === 'string' ? props['sessionId'] : undefined;
      return <ExecuteView sessionId={sessionId} sessionManager={sessionManager} signalBus={signalBus} />;
    },
  },
  sessions: {
    label: 'Sessions',
    render: (_props, sessionManager) => <SessionsView sessionManager={sessionManager} />,
  },
  // Browse views:
  'sprint-list': { label: 'Sprints', render: () => <SprintListView /> },
  'sprint-show': {
    label: 'Sprint',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <SprintShowView sprintId={sprintId} />;
    },
  },
  'ticket-list': { label: 'Tickets', render: () => <TicketListView /> },
  'task-list': { label: 'Tasks', render: () => <TaskListView /> },
  'project-list': { label: 'Projects', render: () => <ProjectListView /> },
  'project-show': {
    label: 'Project',
    render: (props) => {
      const projectName = typeof props['projectName'] === 'string' ? props['projectName'] : undefined;
      return <ProjectShowView projectName={projectName} />;
    },
  },
  // CRUD views:
  'sprint-create': { label: 'Create Sprint', render: () => <SprintCreateView /> },
  'sprint-edit': {
    label: 'Edit Sprint',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <SprintEditView sprintId={sprintId} />;
    },
  },
  'sprint-set-current': { label: 'Set Current Sprint', render: () => <SprintSetCurrentView /> },
  'sprint-activate': {
    label: 'Activate Sprint',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <SprintActivateView sprintId={sprintId} />;
    },
  },
  'sprint-close': { label: 'Close Sprint', render: () => <SprintCloseView /> },
  'sprint-remove': { label: 'Remove Sprint', render: () => <SprintRemoveView /> },
  'ticket-add': { label: 'Add Ticket', render: () => <TicketAddView /> },
  'ticket-edit': { label: 'Edit Ticket', render: () => <TicketEditView /> },
  'ticket-approve': {
    label: 'Approve Ticket',
    render: (props) => {
      const ticketId = typeof props['ticketId'] === 'string' ? props['ticketId'] : undefined;
      return <TicketApproveView ticketId={ticketId} />;
    },
  },
  'ticket-remove': { label: 'Remove Ticket', render: () => <TicketRemoveView /> },
  'project-add': {
    label: 'Add Project',
    render: (props) => {
      const firstLaunch = props['firstLaunch'] === true;
      return <ProjectAddView firstLaunch={firstLaunch} />;
    },
  },
  'project-edit': { label: 'Edit Project', render: () => <ProjectEditView /> },
  'project-remove': { label: 'Remove Project', render: () => <ProjectRemoveView /> },
  'project-repo-add': { label: 'Add Repo', render: () => <ProjectRepoAddView /> },
  'project-repo-remove': { label: 'Remove Repo', render: () => <ProjectRepoRemoveView /> },
  'task-add': { label: 'Add Task', render: () => <TaskAddView /> },
  'task-edit': {
    label: 'Edit Task',
    render: (props) => {
      const taskId = typeof props['taskId'] === 'string' ? props['taskId'] : undefined;
      return <TaskEditView taskId={taskId} />;
    },
  },
  'task-edit-status': { label: 'Update Task Status', render: () => <TaskEditStatusView /> },
  'task-remove': { label: 'Remove Task', render: () => <TaskRemoveView /> },
  // System views:
  doctor: { label: 'Doctor', render: () => <DoctorView /> },
  progress: { label: 'Progress', render: () => <ProgressView /> },
  'sprint-export-requirements': {
    label: 'Export Requirements',
    render: () => <SprintExportRequirementsView />,
  },
  'sprint-export-context': {
    label: 'Export Context',
    render: () => <SprintExportContextView />,
  },
};

interface Props {
  readonly initialStack: readonly ViewEntry[];
  readonly sessionManager: SessionManagerPort | null;
  /**
   * Optional signal bus for live observability events (rate-limit pause /
   * resume, task lifecycle). Only consumed by the ExecuteView today; absent
   * during one-shot CLI prompts which never see live events.
   */
  readonly signalBus?: SignalBusPort | null;
}

export function ViewRouter({ initialStack, sessionManager, signalBus = null }: Props): React.JSX.Element {
  const [stack, setStack] = useState<readonly ViewEntry[]>(() => {
    // Restore the stack the user was on before the App went null
    // (interactive AI session). Without this, returning from a Claude
    // refine/plan handover lands the user back on `home` even though
    // they were on `execute`. See router-stack-cache.ts for the why.
    const cached = getCachedStack();
    if (cached !== null && cached.length > 0) return cached;
    if (initialStack.length === 0) return [{ id: 'home' }] as const;
    return collapseAdjacentDuplicates(initialStack);
  });

  // Mirror every stack change into the cache so the next mount
  // (after an interactive null-render) picks up where we left off.
  useEffect(() => {
    setCachedStack(stack);
  }, [stack]);

  // Help overlay state — toggled by the `?` global key.
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const toggleHelp = useCallback(() => {
    setIsHelpOpen((v) => !v);
  }, []);
  const closeHelp = useCallback(() => {
    setIsHelpOpen(false);
  }, []);

  const push = useCallback((entry: ViewEntry): void => {
    setStack((s) => {
      const top = s[s.length - 1];
      if (top?.id === entry.id && samePropsBag(top.props, entry.props)) return s;
      return [...s, entry];
    });
  }, []);

  const pop = useCallback((): void => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const replace = useCallback((entry: ViewEntry): void => {
    setStack((s) => (s.length === 0 ? [entry] : [...s.slice(0, -1), entry]));
  }, []);

  const reset = useCallback((entry: ViewEntry): void => {
    setStack(() => [entry]);
  }, []);

  const current = stack[stack.length - 1];
  if (current === undefined) {
    throw new Error('ViewRouter stack is empty');
  }

  const api: RouterApi = useMemo(
    () => ({ current, stack, push, pop, replace, reset }),
    [current, stack, push, pop, replace, reset]
  );

  // Active session label + count for the status bar sessions indicator.
  // Both come from the same subscription so the count and the active
  // session reflect a consistent snapshot. Using a single state object
  // also avoids the "stale list on every render" pitfall — calling
  // `sessionManager.list()` outside the effect would change on every
  // re-render even when the registry hasn't moved.
  const [sessionsState, setSessionsState] = useState<{
    readonly active: SessionDescriptor | null;
    readonly all: readonly SessionDescriptor[];
  }>(() => ({
    active: sessionManager?.active ?? null,
    all: sessionManager?.list() ?? [],
  }));
  useEffect(() => {
    if (!sessionManager) return;
    // Cancel guard — the registry can fire a final event on shutdown
    // after the router has unmounted (Ink unmount is async). Without it
    // React warns "setState on an unmounted component".
    const mounted = { current: true };
    const refresh = (): void => {
      if (!mounted.current) return;
      setSessionsState({
        active: sessionManager.active ?? null,
        all: sessionManager.list(),
      });
    };
    refresh();
    const unsub = sessionManager.subscribe(refresh);
    return () => {
      mounted.current = false;
      unsub();
    };
  }, [sessionManager]);

  const activeSession = sessionsState.active;
  const allSessions = sessionsState.all;
  const activeSessionMeta = activeSession
    ? {
        label: activeSession.label,
        index: allSessions.findIndex((s) => s.id === activeSession.id),
        total: allSessions.length,
      }
    : null;

  const meta = views[current.id];
  const props = current.props ?? {};

  return (
    <RouterProvider value={api}>
      <ViewHintsProvider key={current.id}>
        {isHelpOpen ? (
          // Modal takeover — the help overlay is the only thing on screen
          // while open. View tree, prompts, hints, status bar are all
          // suspended. Esc / `?` closes and returns to the view in the
          // exact state it was left.
          <HelpOverlay onClose={closeHelp} />
        ) : (
          <Box flexDirection="column">
            {meta.render(props, sessionManager, signalBus)}
            <PromptHost />
            <Box marginTop={spacing.section}>
              <KeyboardHints />
            </Box>
            <Box
              marginTop={spacing.section}
              borderStyle="round"
              borderColor={inkColors.primary}
              borderDimColor
              paddingX={spacing.indent}
            >
              <StatusBar
                breadcrumb={stack.map((e) => views[e.id].label)}
                hints={buildHints(current.id, stack.length, sessionManager)}
                activeSession={activeSessionMeta}
              />
            </Box>
          </Box>
        )}
        {/* Global key handler — suspended while the help overlay is open so the overlay owns the keyboard. */}
        <GlobalKeyHandler sessionManager={sessionManager} onToggleHelp={toggleHelp} suspended={isHelpOpen} />
      </ViewHintsProvider>
    </RouterProvider>
  );
}

/**
 * Thin component that installs `useGlobalKeys` inside the RouterProvider so
 * the hook can call `useRouter()`. Rendered as a sibling of the view tree —
 * Ink doesn't care that it renders nothing.
 */
function GlobalKeyHandler({
  sessionManager,
  onToggleHelp,
  suspended,
}: {
  readonly sessionManager: SessionManagerPort | null;
  readonly onToggleHelp: () => void;
  readonly suspended: boolean;
}): null {
  useGlobalKeys({ sessionManager, onToggleHelp, suspended });
  return null;
}

function samePropsBag(a: ViewEntry['props'], b: ViewEntry['props']): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.is(a[k], b[k]));
}

function collapseAdjacentDuplicates(stack: readonly ViewEntry[]): readonly ViewEntry[] {
  const out: ViewEntry[] = [];
  for (const entry of stack) {
    const top = out[out.length - 1];
    if (top?.id === entry.id && samePropsBag(top.props, entry.props)) continue;
    out.push(entry);
  }
  return out;
}

function buildHints(
  currentId: ViewId,
  depth: number,
  sessionManager: SessionManagerPort | null
): readonly { key: string; action: string }[] {
  const hints: { key: string; action: string }[] = [];
  if (depth > 1) hints.push({ key: 'esc', action: 'back' });
  if (currentId !== 'home') hints.push({ key: 'h', action: 'home' });
  if (currentId !== 'settings') hints.push({ key: 's', action: 'settings' });
  if (currentId !== 'dashboard') hints.push({ key: 'd', action: 'dashboard' });
  const hasSessions = (sessionManager?.list().length ?? 0) > 0;
  if (hasSessions) hints.push({ key: 'Tab', action: 'next session' });
  if (currentId !== 'sessions') hints.push({ key: 'x', action: 'sessions' });
  if (currentId !== 'doctor') hints.push({ key: '!', action: 'doctor' });
  hints.push({ key: '?', action: 'help' });
  if (currentId === 'home' && depth === 1) hints.push({ key: 'q', action: 'quit' });
  return hints;
}
