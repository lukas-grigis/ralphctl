/**
 * ExecutionNotificationBanner — ambient toast for backgrounded executions.
 *
 * Subscribes to the registry and surfaces the most recent terminal transition
 * for an execution the user has not yet visited after settlement. Mounted in
 * the router chrome between the Banner and the current view so it is visible
 * everywhere.
 *
 * Design:
 *   - Tracks `seen` terminal execution ids in a ref. An execution id is marked
 *     seen when the user opens its live view OR opens the running-executions
 *     list after the entry has settled. This prevents a toast from reappearing
 *     on subsequent renders.
 *   - Cancelled transitions never render — the user requested the terminal
 *     state and a "cancelled" toast is noise.
 *   - Running transitions are ignored entirely; only `completed` / `failed`
 *     surface as notifications.
 *   - Dismiss on any of: pressing Enter on the banner's target (handled by the
 *     running-executions view / execute view), or navigating into the execute
 *     view for that id (the id then counts as visited).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type {
  ExecutionRegistryPort,
  ExecutionStatus,
  RunningExecution,
} from '@src/business/ports/execution-registry.ts';
import { getSharedDeps } from '@src/integration/bootstrap.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { useRegistryEvents } from '@src/integration/ui/tui/runtime/hooks.ts';

const NOOP_REGISTRY: ExecutionRegistryPort = {
  start: () => Promise.reject(new Error('no registry')),
  get: () => null,
  list: () => [],
  cancel: () => undefined,
  subscribe: () => () => undefined,
  getSignalBus: () => null,
  getLogEventBus: () => null,
};

interface Props {
  /** Current view id — used to mark an execution "visited" once the user is on it. */
  readonly currentViewId: string;
}

function isTerminal(status: ExecutionStatus): boolean {
  return status !== 'running';
}

function isNotifiable(status: ExecutionStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function bannerColor(status: ExecutionStatus): string {
  if (status === 'completed') return inkColors.success;
  if (status === 'failed') return inkColors.error;
  return inkColors.muted;
}

function bannerGlyph(status: ExecutionStatus): string {
  if (status === 'completed') return glyphs.check;
  if (status === 'failed') return glyphs.cross;
  return glyphs.warningGlyph;
}

function bannerLabel(status: ExecutionStatus): string {
  if (status === 'completed') return 'DONE';
  if (status === 'failed') return 'FAILED';
  return 'ENDED';
}

export function ExecutionNotificationBanner({ currentViewId }: Props): React.JSX.Element | null {
  const shared = (() => {
    try {
      return getSharedDeps();
    } catch {
      return null;
    }
  })();
  const registry = shared?.executionRegistry ?? null;

  const executions = useRegistryEvents(registry ?? NOOP_REGISTRY);

  // Track ids we have already shown a notification for so the banner is
  // single-fire per transition.
  const shownRef = useRef<Set<string>>(new Set());
  // Track ids the user has *visited* while the entry was in a terminal state.
  // Visiting marks the id notified.
  const visitedRef = useRef<Set<string>>(new Set());
  const [pending, setPending] = useState<RunningExecution | null>(null);

  // Mark the current viewed execution as seen once we land on it, AND mark the
  // whole list as seen when the user opens the running-executions list.
  useEffect(() => {
    if (currentViewId === 'running-executions') {
      for (const e of executions) {
        if (isTerminal(e.status)) visitedRef.current.add(e.id);
      }
      if (pending && visitedRef.current.has(pending.id)) {
        setPending(null);
      }
    }
  }, [currentViewId, executions, pending]);

  // Detect fresh terminal transitions and promote them to the banner slot.
  useEffect(() => {
    for (const e of executions) {
      if (!isTerminal(e.status)) continue;
      if (!isNotifiable(e.status)) continue;
      if (shownRef.current.has(e.id)) continue;
      if (visitedRef.current.has(e.id)) {
        // User already on the execution's view — no toast, but mark shown.
        shownRef.current.add(e.id);
        continue;
      }
      shownRef.current.add(e.id);
      setPending(e);
      break;
    }
  }, [executions]);

  if (!pending) return null;

  const color = bannerColor(pending.status);
  const icon = bannerGlyph(pending.status);
  const label = bannerLabel(pending.status);

  return (
    <Box borderStyle="round" borderColor={color} paddingX={spacing.cardPadX} marginBottom={spacing.section}>
      <Text color={color} bold>
        {icon}{' '}
      </Text>
      <Text bold>
        {pending.projectName} {glyphs.inlineDot} {pending.sprint.name}
      </Text>
      <Text color={color} bold>
        {'  '}
        {label}
      </Text>
      <Text dimColor>{`  ${glyphs.emDash} press `}</Text>
      <Text bold>x</Text>
      <Text dimColor> for the runs list</Text>
    </Box>
  );
}
