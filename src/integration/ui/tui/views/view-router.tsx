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
import { StatusBar } from '@src/integration/ui/tui/components/status-bar.tsx';
import { useCurrentPrompt } from '@src/integration/prompts/hooks.ts';
import { RouterProvider, type RouterApi, type ViewEntry, type ViewId } from './router-context.ts';
import { HomeView } from './home-view.tsx';
import { SettingsView } from './settings-view.tsx';
import { ExecuteView } from './execute-view.tsx';
import { DashboardView } from './dashboard-view.tsx';
import { RefinePhaseView } from './phases/refine-phase-view.tsx';
import { PlanPhaseView } from './phases/plan-phase-view.tsx';
import { ClosePhaseView } from './phases/close-phase-view.tsx';

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
    return initialStack;
  });

  // Keep a ref in sync so global key handlers can read the current stack
  // length without triggering re-renders or stale closures.
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const push = useCallback((entry: ViewEntry): void => {
    setStack((s) => [...s, entry]);
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
      <Box flexDirection="column">
        {meta.render(props)}
        <Box marginTop={1}>
          <StatusBar breadcrumb={stack.map((e) => views[e.id].label)} hints={buildHints(current.id, stack.length)} />
        </Box>
      </Box>
    </RouterProvider>
  );
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
  if (currentId === 'home' && depth === 1) {
    hints.push({ key: 'q', action: 'quit' });
  }
  return hints;
}
