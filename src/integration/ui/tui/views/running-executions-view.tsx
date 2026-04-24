/**
 * RunningExecutionsView — destination for the global `x` hotkey.
 *
 * Subscribes to the `ExecutionRegistryPort` via `useRegistryEvents` and
 * renders one row per execution the registry has ever seen this session.
 * Each row carries a project name, sprint name, status chip, and relative
 * "started N ago" timestamp.
 *
 * Interactions:
 *   - ↑/↓ move the cursor
 *   - Enter opens the execution's live view (router pushes `execute` with the
 *     existing executionId)
 *   - X cancels the highlighted execution via `registry.cancel(id)` (lowercase
 *     `x` is the global hotkey that lands on this view, so the list-local
 *     action uses uppercase `X` to avoid bouncing back to itself)
 *
 * Empty state is informational — the user sees "No backgrounded executions"
 * with a hint pointing them to `sprint start`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { RunningExecution } from '@src/business/ports/execution-registry.ts';
import { getSharedDeps } from '@src/integration/bootstrap.ts';
import { ListView, type ListColumn } from '@src/integration/ui/tui/components/list-view.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { chipKindForExecutionStatus, type StatusKind } from '@src/integration/ui/tui/components/status-chip.tsx';
import { useRegistryEvents } from '@src/integration/ui/tui/runtime/hooks.ts';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';

const HINTS_POPULATED = [
  { key: '↑/↓', action: 'navigate' },
  { key: 'Enter', action: 'open' },
  { key: 'X', action: 'cancel' },
  { key: 'Esc', action: 'back' },
] as const;
const HINTS_EMPTY = [{ key: 'Esc', action: 'back' }] as const;

function formatRelativeTime(from: Date, now: Date = new Date()): string {
  const deltaMs = Math.max(0, now.getTime() - from.getTime());
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function statusColor(kind: StatusKind): string {
  const map: Record<StatusKind, string> = {
    info: inkColors.info,
    success: inkColors.success,
    warning: inkColors.warning,
    error: inkColors.error,
    muted: inkColors.muted,
  };
  return map[kind];
}

function buildColumns(now: Date): readonly ListColumn<RunningExecution>[] {
  return [
    {
      header: 'Status',
      cell: (e) => `[${e.status.toUpperCase()}]`,
      color: (e) => statusColor(chipKindForExecutionStatus(e.status)),
      width: 12,
    },
    { header: 'Project', cell: (e) => e.projectName, width: 20 },
    { header: 'Sprint', cell: (e) => e.sprint.name, flex: true },
    {
      header: 'Started',
      cell: (e) => formatRelativeTime(e.startedAt, now),
      width: 10,
      align: 'right',
    },
  ];
}

export function RunningExecutionsView(): React.JSX.Element {
  const router = useRouter();
  const shared = getSharedDeps();
  const registry = shared.executionRegistry;
  const executions = useRegistryEvents(registry);
  const [cursor, setCursor] = useState(0);

  const rows = useMemo(() => {
    // Newest first — most recent action is what the user is usually after.
    return [...executions].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }, [executions]);

  // Tick `now` every second so the "started N ago" column updates live even
  // when no registry transition has fired. A stale `now` here would freeze
  // the relative timestamp between transitions, contradicting the live feel.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, []);
  const columns = useMemo(() => buildColumns(now), [now]);

  const handleSelect = useCallback(
    (execution: RunningExecution) => {
      router.push({
        id: 'execute',
        props: { sprintId: execution.sprintId, executionId: execution.id },
      });
    },
    [router]
  );

  const handleCursorChange = useCallback((_row: RunningExecution, index: number) => {
    setCursor(index);
  }, []);

  useViewHints(rows.length > 0 ? HINTS_POPULATED : HINTS_EMPTY);

  // View-local `X` (uppercase) cancels the highlighted execution. Lowercase
  // `x` is the global hotkey and would bounce back to this same view.
  useInput((input) => {
    if (rows.length === 0) return;
    if (input !== 'X') return;
    const target = rows[cursor];
    if (target?.status === 'running') {
      registry.cancel(target.id);
    }
  });

  if (rows.length === 0) {
    return (
      <ViewShell title="Running Executions">
        <ResultCard
          kind="info"
          title="No backgrounded executions"
          lines={['Start a sprint from home to see it here while it runs.']}
          nextSteps={[{ action: 'Press h to return home', description: 'Then pick a sprint and start it.' }]}
        />
      </ViewShell>
    );
  }

  return (
    <ViewShell title="Running Executions">
      <Box flexDirection="column">
        <ListView<RunningExecution>
          rows={rows}
          columns={columns}
          onSelect={handleSelect}
          onCursorChange={handleCursorChange}
          emptyLabel="No executions"
        />
        <Box marginTop={spacing.section}>
          <Text dimColor>
            {rows.length} execution{rows.length === 1 ? '' : 's'} tracked this session.
          </Text>
        </Box>
      </Box>
    </ViewShell>
  );
}
