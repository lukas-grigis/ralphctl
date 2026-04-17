/**
 * ViewRouter — navigation stack for the Ink TUI.
 *
 * The router is the single source of truth for which view is on screen. It
 * owns the stack, exposes `{push, pop, replace, reset}` via React context,
 * and handles the global hotkeys that work the same everywhere:
 *
 *   - Esc → pop one frame (no-op at root, so users at home don't accidentally exit)
 *   - h   → reset to [home] (single jump back to landing screen)
 *   - s   → push settings on top of whatever is on screen
 *   - q   → exit the Ink app (only when at home root — elsewhere `q` is free
 *           for views to use as a regular character if they want)
 *
 * The status bar at the bottom is the only persistent chrome — banners and
 * dashboard headers belong inside the views that need them. This is what
 * makes navigating between views feel like SPA navigation rather than
 * stacking overlays on top of a shared shell.
 *
 * Submenus, busy indicators, and any other "view-internal" state stay inside
 * the view. Only top-level destinations live on the router stack.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { Banner } from '@src/integration/ui/tui/components/banner.tsx';
import { StatusBar } from '@src/integration/ui/tui/components/status-bar.tsx';
import { KeyboardHints } from '@src/integration/ui/tui/components/keyboard-hints.tsx';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { PromptHost } from '@src/integration/ui/prompts/prompt-host.tsx';
import { useCurrentPrompt } from '@src/integration/ui/prompts/hooks.ts';
import { ViewHintsProvider } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { RouterProvider, type RouterApi, type ViewEntry, type ViewId } from './router-context.ts';
import { HomeView } from './home-view.tsx';
import { SettingsView } from './settings-view.tsx';
import { ExecuteView } from './execute-view.tsx';
import { DashboardView } from './dashboard-view.tsx';
import { RefinePhaseView } from './phases/refine-phase-view.tsx';
import { PlanPhaseView } from './phases/plan-phase-view.tsx';
import { ClosePhaseView } from './phases/close-phase-view.tsx';
import { CreateSprintView } from './workflows/create-sprint-view.tsx';
import { DeleteSprintView } from './workflows/delete-sprint-view.tsx';
import { SetCurrentSprintView } from './workflows/set-current-sprint-view.tsx';
import { RequirementsExportView } from './workflows/requirements-export-view.tsx';
import { ContextExportView } from './workflows/context-export-view.tsx';
import { TicketAddView } from './workflows/ticket-add-view.tsx';
import { TicketEditView } from './workflows/ticket-edit-view.tsx';
import { TicketRemoveView } from './workflows/ticket-remove-view.tsx';
import { TicketRefineView } from './workflows/ticket-refine-view.tsx';
import { TaskAddView } from './workflows/task-add-view.tsx';
import { TaskImportView } from './workflows/task-import-view.tsx';
import { TaskStatusView } from './workflows/task-status-view.tsx';
import { TaskReorderView } from './workflows/task-reorder-view.tsx';
import { TaskRemoveView } from './workflows/task-remove-view.tsx';
import { TaskNextView } from './workflows/task-next-view.tsx';
import { ProjectAddView } from './workflows/project-add-view.tsx';
import { ProjectRemoveView } from './workflows/project-remove-view.tsx';
import { ProjectRepoAddView } from './workflows/project-repo-add-view.tsx';
import { ProjectRepoRemoveView } from './workflows/project-repo-remove-view.tsx';
import { ProjectEditView } from './workflows/project-edit-view.tsx';
import { SprintListView } from './browse/sprint-list-view.tsx';
import { SprintShowView } from './browse/sprint-show-view.tsx';
import { TicketListView } from './browse/ticket-list-view.tsx';
import { TicketShowView } from './browse/ticket-show-view.tsx';
import { TaskListView } from './browse/task-list-view.tsx';
import { TaskShowView } from './browse/task-show-view.tsx';
import { ProjectListView } from './browse/project-list-view.tsx';
import { ProjectShowView } from './browse/project-show-view.tsx';
import { DoctorView } from './browse/doctor-view.tsx';
import { ProgressShowView } from './browse/progress-show-view.tsx';
import { ProgressLogView } from './workflows/progress-log-view.tsx';
import { IdeateView } from './workflows/ideate-view.tsx';
import { OnboardingView } from './onboarding-view.tsx';
import { ReactivateSprintView } from './workflows/reactivate-sprint-view.tsx';
import { EvaluationsView } from './browse/evaluations-view.tsx';
import { EvaluationShowView } from './browse/evaluation-show-view.tsx';
import { FeedbackView } from './browse/feedback-view.tsx';
import { VersionHint } from '@src/integration/ui/tui/components/version-hint.tsx';

/**
 * The view registry. Adding a new top-level destination is one entry here +
 * one entry in `ViewId`. Each entry knows how to render its view from the
 * raw `props` bag on the stack frame — this keeps view components free of
 * router-specific typing while letting the router validate prop shape at
 * the dispatch boundary.
 */
const views: Record<ViewId, { label: string; render(props: Readonly<Record<string, unknown>>): React.JSX.Element }> = {
  home: {
    label: 'Home',
    render: () => <HomeView />,
  },
  settings: {
    label: 'Settings',
    render: () => <SettingsView />,
  },
  execute: {
    label: 'Execute',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : '';
      const executionOptions = props['executionOptions'] as
        | React.ComponentProps<typeof ExecuteView>['executionOptions']
        | undefined;
      return <ExecuteView sprintId={sprintId} executionOptions={executionOptions} />;
    },
  },
  dashboard: {
    label: 'Dashboard',
    render: () => <DashboardView />,
  },
  'refine-phase': {
    label: 'Refine',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : '';
      return <RefinePhaseView sprintId={sprintId} />;
    },
  },
  'plan-phase': {
    label: 'Plan',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : '';
      return <PlanPhaseView sprintId={sprintId} />;
    },
  },
  'close-phase': {
    label: 'Close',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : '';
      return <ClosePhaseView sprintId={sprintId} />;
    },
  },
  'sprint-create': {
    label: 'Create Sprint',
    render: () => <CreateSprintView />,
  },
  'sprint-delete': {
    label: 'Delete Sprint',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <DeleteSprintView sprintId={sprintId} />;
    },
  },
  'sprint-set-current': {
    label: 'Set Current',
    render: () => <SetCurrentSprintView />,
  },
  'sprint-requirements-export': {
    label: 'Requirements',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <RequirementsExportView sprintId={sprintId} />;
    },
  },
  'sprint-context-export': {
    label: 'Context',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <ContextExportView sprintId={sprintId} />;
    },
  },
  'ticket-add': {
    label: 'Add Ticket',
    render: () => <TicketAddView />,
  },
  'ticket-edit': {
    label: 'Edit Ticket',
    render: (props) => {
      const ticketId = typeof props['ticketId'] === 'string' ? props['ticketId'] : undefined;
      return <TicketEditView ticketId={ticketId} />;
    },
  },
  'ticket-remove': {
    label: 'Remove Ticket',
    render: () => <TicketRemoveView />,
  },
  'ticket-refine': {
    label: 'Re-Refine Ticket',
    render: () => <TicketRefineView />,
  },
  'task-add': { label: 'Add Task', render: () => <TaskAddView /> },
  'task-import': { label: 'Import Tasks', render: () => <TaskImportView /> },
  'task-status': { label: 'Task Status', render: () => <TaskStatusView /> },
  'task-reorder': { label: 'Reorder Task', render: () => <TaskReorderView /> },
  'task-remove': { label: 'Remove Task', render: () => <TaskRemoveView /> },
  'task-next': { label: 'Next Task', render: () => <TaskNextView /> },
  'project-add': { label: 'Add Project', render: () => <ProjectAddView /> },
  'project-remove': { label: 'Remove Project', render: () => <ProjectRemoveView /> },
  'project-repo-add': { label: 'Add Repository', render: () => <ProjectRepoAddView /> },
  'project-repo-remove': { label: 'Remove Repository', render: () => <ProjectRepoRemoveView /> },
  'project-edit': { label: 'Edit Project', render: () => <ProjectEditView /> },
  'sprint-list': { label: 'Sprints', render: () => <SprintListView /> },
  'sprint-show': {
    label: 'Sprint',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <SprintShowView sprintId={sprintId} />;
    },
  },
  'ticket-list': { label: 'Tickets', render: () => <TicketListView /> },
  'ticket-show': {
    label: 'Ticket',
    render: (props) => {
      const ticketId = typeof props['ticketId'] === 'string' ? props['ticketId'] : undefined;
      return <TicketShowView ticketId={ticketId} />;
    },
  },
  'task-list': { label: 'Tasks', render: () => <TaskListView /> },
  'task-show': {
    label: 'Task',
    render: (props) => {
      const taskId = typeof props['taskId'] === 'string' ? props['taskId'] : undefined;
      return <TaskShowView taskId={taskId} />;
    },
  },
  'project-list': { label: 'Projects', render: () => <ProjectListView /> },
  'project-show': {
    label: 'Project',
    render: (props) => {
      const projectName = typeof props['projectName'] === 'string' ? props['projectName'] : undefined;
      return <ProjectShowView projectName={projectName} />;
    },
  },
  doctor: { label: 'Doctor', render: () => <DoctorView /> },
  'progress-log': { label: 'Log Progress', render: () => <ProgressLogView /> },
  'progress-show': {
    label: 'Progress',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <ProgressShowView sprintId={sprintId} />;
    },
  },
  ideate: { label: 'Ideate', render: () => <IdeateView /> },
  onboarding: { label: 'Welcome', render: () => <OnboardingView /> },
  'sprint-reactivate': {
    label: 'Reactivate Sprint',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <ReactivateSprintView sprintId={sprintId} />;
    },
  },
  evaluations: {
    label: 'Evaluations',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <EvaluationsView sprintId={sprintId} />;
    },
  },
  'evaluation-show': {
    label: 'Evaluation',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : '';
      const taskId = typeof props['taskId'] === 'string' ? props['taskId'] : '';
      return <EvaluationShowView sprintId={sprintId} taskId={taskId} />;
    },
  },
  feedback: {
    label: 'Feedback',
    render: (props) => {
      const sprintId = typeof props['sprintId'] === 'string' ? props['sprintId'] : undefined;
      return <FeedbackView sprintId={sprintId} />;
    },
  },
};

interface Props {
  /** Initial stack — at least one entry required. */
  readonly initialStack: readonly ViewEntry[];
}

export function ViewRouter({ initialStack }: Props): React.JSX.Element {
  const app = useApp();
  const [stack, setStack] = useState<readonly ViewEntry[]>(() => {
    if (initialStack.length === 0) {
      return [{ id: 'home' }] as const;
    }
    return collapseAdjacentDuplicates(initialStack);
  });

  // Keep a ref in sync so global key handlers can read the current stack
  // length without triggering re-renders or stale closures.
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const push = useCallback((entry: ViewEntry): void => {
    setStack((s) => {
      // Belt-and-braces: never stack identical adjacent frames. If the target
      // matches the current top (same id + same props), this is a duplicate
      // push and would surface as e.g. "Home › Home › …" in the breadcrumb.
      const top = s[s.length - 1];
      if (top?.id === entry.id && samePropsBag(top.props, entry.props)) {
        return s;
      }
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
    // Defensive: should be impossible because `setStack` guards never empty
    // the stack and the initial state guarantees at least one frame.
    throw new Error('ViewRouter stack is empty');
  }

  const api: RouterApi = useMemo(
    () => ({ current, stack, push, pop, replace, reset }),
    [current, stack, push, pop, replace, reset]
  );

  // Global hotkeys. Per-view `useInput` handlers run in parallel — Ink
  // multiplexes input, so view-level navigation (arrow keys, Enter) keeps
  // working alongside these.
  //
  // While a prompt is pending, the user is typing into an input field — we
  // must NOT intercept plain characters like `s`/`d`/`h`/`q` or Esc (which
  // the prompt uses to cancel). The prompt's own `useInput` handler owns the
  // keyboard until it resolves; disabling our router hotkeys is the cleanest
  // way to achieve that with Ink's multiplexed input model.
  const currentPrompt = useCurrentPrompt();
  const routerHotkeysActive = currentPrompt === null;

  useInput(
    (input, key) => {
      if (key.escape) {
        pop();
        return;
      }
      if (input === 'h') {
        reset({ id: 'home' });
        return;
      }
      if (input === 's' && current.id !== 'settings') {
        // Avoid stacking settings on top of itself.
        push({ id: 'settings' });
        return;
      }
      if (input === 'd' && current.id !== 'dashboard') {
        // Avoid stacking dashboard on top of itself.
        push({ id: 'dashboard' });
        return;
      }
      if (input === '?' && current.id !== 'doctor') {
        push({ id: 'doctor' });
        return;
      }
      if (input === 'q' && stackRef.current.length === 1 && current.id === 'home') {
        app.exit();
      }
    },
    { isActive: routerHotkeysActive }
  );

  const meta = views[current.id];
  const props = current.props ?? {};

  return (
    <RouterProvider value={api}>
      <ViewHintsProvider key={current.id}>
        <Box flexDirection="column">
          <Banner />
          {meta.render(props)}
          <PromptHost />
          <Box marginTop={1}>
            <KeyboardHints />
          </Box>
          <Box
            marginTop={1}
            borderStyle="round"
            borderColor={inkColors.primary}
            borderDimColor
            paddingX={spacing.indent}
            justifyContent="space-between"
          >
            <StatusBar breadcrumb={stack.map((e) => views[e.id].label)} hints={buildHints(current.id, stack.length)} />
            <VersionHint />
          </Box>
        </Box>
      </ViewHintsProvider>
    </RouterProvider>
  );
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

function buildHints(currentId: ViewId, depth: number): readonly { key: string; action: string }[] {
  const hints: { key: string; action: string }[] = [];
  if (depth > 1) {
    hints.push({ key: 'esc', action: 'back' });
  }
  if (currentId !== 'home') {
    hints.push({ key: 'h', action: 'home' });
  }
  if (currentId !== 'settings') {
    hints.push({ key: 's', action: 'settings' });
  }
  if (currentId !== 'dashboard') {
    hints.push({ key: 'd', action: 'dashboard' });
  }
  if (currentId !== 'doctor') {
    hints.push({ key: '?', action: 'doctor' });
  }
  if (currentId === 'home' && depth === 1) {
    hints.push({ key: 'b', action: 'browse' });
    hints.push({ key: 'q', action: 'quit' });
  }
  return hints;
}
