/**
 * ExecutionNotificationBanner — terminal-transition tracker for backgrounded
 * executions. Publishes to the shared `notificationBus` instead of rendering
 * its own JSX; the actual surface lives in `<StickyNotification />`, mounted
 * once by the router so every notifier in the app shares one slot.
 *
 * Tracking rules carried over from the original implementation:
 *   - `seen` ids guard against a re-fire if the registry replays the same
 *     transition during a re-render.
 *   - `visited` ids absorb the case where the user is already on the
 *     running-executions list when the entry settles — a toast for a row the
 *     user is already looking at would be noise.
 *   - `cancelled` is never notifiable; the user requested that terminal state.
 */

import { useEffect, useRef } from 'react';
import type {
  ExecutionRegistryPort,
  ExecutionStatus,
  RunningExecution,
} from '@src/business/ports/execution-registry.ts';
import { useRegistryEvents } from '@src/integration/ui/tui/runtime/hooks.ts';
import { notificationBus } from '@src/integration/ui/tui/runtime/notification-bus.ts';
import { useRouterOptional, type RouterApi } from '@src/integration/ui/tui/views/router-context.ts';

interface Props {
  /** Current view id — used to mark an execution "visited" once the user is on it. */
  readonly currentViewId: string;
  /**
   * Execution registry to subscribe to. Pass `null` when no registry is
   * available (e.g. plain-text CLI mount) — the tracker no-ops.
   * The router owns the registry lookup so this component never reaches
   * into `getSharedDeps()` at render time.
   */
  readonly registry: ExecutionRegistryPort | null;
}

function isTerminal(status: ExecutionStatus): boolean {
  return status !== 'running';
}

function isNotifiable(status: ExecutionStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function statusGroup(status: ExecutionStatus): 'success' | 'error' {
  return status === 'completed' ? 'success' : 'error';
}

function bannerLabel(status: ExecutionStatus): string {
  if (status === 'completed') return 'DONE';
  if (status === 'failed') return 'FAILED';
  return 'ENDED';
}

function buildAction(routerRef: { current: RouterApi | null }): {
  key: string;
  label: string;
  run(): Promise<{ ok: true } | { ok: false; error: string }>;
} {
  return {
    key: 'x',
    label: 'the runs list',
    run: async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      const router = routerRef.current;
      if (router === null) {
        return Promise.resolve({ ok: false, error: 'Navigation unavailable' });
      }
      router.push({ id: 'running-executions' });
      return Promise.resolve({ ok: true });
    },
  };
}

function buildNotificationFor(
  execution: RunningExecution,
  routerRef: { current: RouterApi | null }
): {
  id: string;
  message: string;
  status: 'success' | 'error';
  action: ReturnType<typeof buildAction>;
} {
  return {
    id: `execution-${execution.id}`,
    message: `${execution.projectName} · ${execution.sprint.name} ${bannerLabel(execution.status)}`,
    status: statusGroup(execution.status),
    action: buildAction(routerRef),
  };
}

export function ExecutionNotificationBanner({ currentViewId, registry }: Props): null {
  const executions = useRegistryEvents(registry);
  const router = useRouterOptional();

  // Stable ref so the action closure always uses the latest router instance,
  // even though useRouterOptional() returns the same identity per mount.
  const routerRef = useRef<RouterApi | null>(router);
  routerRef.current = router;

  // Track ids we have already shown a notification for so the bus is
  // single-fire per transition.
  const shownRef = useRef<Set<string>>(new Set());
  // Track ids the user has *visited* while the entry was in a terminal state.
  // Visiting marks the id notified.
  const visitedRef = useRef<Set<string>>(new Set());

  // Mark visited when the user lands on the running-executions list.
  useEffect(() => {
    if (currentViewId !== 'running-executions') return;
    let dismissedActive = false;
    for (const e of executions) {
      if (!isTerminal(e.status)) continue;
      visitedRef.current.add(e.id);
      const active = notificationBus.current();
      if (!dismissedActive && active?.id === `execution-${e.id}`) {
        notificationBus.clear(active.id);
        dismissedActive = true;
      }
    }
  }, [currentViewId, executions]);

  // Detect fresh terminal transitions and publish to the bus.
  useEffect(() => {
    for (const e of executions) {
      if (!isTerminal(e.status)) continue;
      if (!isNotifiable(e.status)) continue;
      if (shownRef.current.has(e.id)) continue;
      if (visitedRef.current.has(e.id)) {
        // User is already on the runs list — no toast, but mark shown.
        shownRef.current.add(e.id);
        continue;
      }
      shownRef.current.add(e.id);
      notificationBus.show(buildNotificationFor(e, routerRef));
      break;
    }
  }, [executions]);

  return null;
}
