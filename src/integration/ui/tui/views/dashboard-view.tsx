/**
 * DashboardView — full-screen "what's going on" destination.
 *
 * The previous design rendered a compact dashboard header inline in Home above
 * the action menu. That conflated chrome with content: opening the menu also
 * forced the header on screen, and there was no way to focus on the sprint
 * state alone. Dashboard now lives as its own router destination so the UX
 * feels like a website — Home shows the menu, Dashboard shows the data.
 *
 * Layout (top-down):
 *   - Hero: sprint name, status, ticket/task counts, provider, completion bar
 *   - Task grid: one row per task with status, name, project path
 *   - Blockers panel: tasks with unmet `blockedBy` deps (empty state when none)
 *   - Progress tail: last N entries from `progress.md` (latest first)
 *   - Next action hint: same `getNextAction()` Home uses
 *
 * Reuses `<TaskGrid />` and `<SprintSummary />` from the execute components —
 * the visual language matches what users see during `sprint start`.
 *
 * Refresh model: data loads on mount via `useDashboardData()`. Auto-refresh
 * during execution is `<ExecuteView />`'s job; here we stay simple — Esc/h
 * navigation re-mounts the view, which re-runs the loader.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useDashboardData } from '@src/integration/ui/tui/runtime/hooks.ts';
import { TaskGrid } from '@src/integration/ui/tui/components/task-grid.tsx';
import { SprintSummary } from '@src/integration/ui/tui/components/sprint-summary.tsx';
import { getNextAction } from '@src/integration/ui/tui/views/dashboard-data.ts';
import { getProgress } from '@src/integration/persistence/progress.ts';
import { inkColors } from '@src/integration/ui/tui/theme/tokens.ts';
import type { DashboardData } from '@src/integration/ui/tui/views/dashboard-data.ts';
import type { Task } from '@src/domain/models.ts';

const PROGRESS_TAIL_LIMIT = 8;

interface ProgressEntry {
  /** Markdown header (timestamp + optional task name). */
  header: string;
  /** Body text (first 200 chars, single-line preview). */
  preview: string;
}

/**
 * Pulls the most recent N entries from progress.md. Returns newest first so
 * the tail visually matches a chat log. Errors and "no progress yet" both
 * resolve to an empty array — the panel renders its own empty state.
 */
async function loadRecentProgress(sprintId: string, limit: number): Promise<readonly ProgressEntry[]> {
  try {
    const text = await getProgress(sprintId);
    if (!text.trim()) return [];

    const entries = text.split(/\n---\n/).filter((e) => e.trim());
    const recent = entries.slice(-limit).reverse();

    return recent.map((entry) => {
      const headerMatch = /^##\s+(.+)$/m.exec(entry);
      const header = headerMatch?.[1]?.trim() ?? 'Entry';

      // Strip headers and "Project: …" markers, then take a one-line preview.
      const body = entry
        .replace(/^##\s+.+$/gm, '')
        .replace(/^\*\*Project:\*\*.+$/gm, '')
        .replace(/^###\s+.+$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
      const preview = body.length > 200 ? body.slice(0, 197) + '…' : body;

      return { header, preview };
    });
  } catch {
    return [];
  }
}

function getBlockedTasks(data: DashboardData): readonly Task[] {
  const { tasks } = data;
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return tasks.filter(
    (t) => t.status !== 'done' && t.blockedBy.length > 0 && !t.blockedBy.every((id) => doneIds.has(id))
  );
}

function Hero({ data }: { data: DashboardData }): React.JSX.Element {
  const { sprint, tasks, aiProvider } = data;
  const ticketCount = sprint.tickets.length;
  const taskCount = tasks.length;
  const providerLabel = aiProvider === 'claude' ? 'Claude' : aiProvider === 'copilot' ? 'Copilot' : null;

  const statusColor =
    sprint.status === 'active' ? inkColors.success : sprint.status === 'closed' ? inkColors.info : inkColors.muted;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={inkColors.primary}>
          {sprint.name}
        </Text>
        <Text>{'  '}</Text>
        <Text color={statusColor}>[{sprint.status}]</Text>
        {sprint.branch ? (
          <Text dimColor>
            {'  '}
            {sprint.branch}
          </Text>
        ) : null}
      </Box>
      <Box>
        <Text dimColor>
          {String(ticketCount)} ticket{ticketCount !== 1 ? 's' : ''} · {String(taskCount)} task
          {taskCount !== 1 ? 's' : ''}
          {providerLabel ? `  ·  Provider: ${providerLabel}` : ''}
        </Text>
      </Box>
      {taskCount > 0 ? (
        <Box marginTop={1}>
          <SprintSummary tasks={tasks} />
        </Box>
      ) : null}
    </Box>
  );
}

function BlockersPanel({ blocked }: { blocked: readonly Task[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>── Blockers ───────────────────────</Text>
      {blocked.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        blocked.map((t) => (
          <Box key={t.id}>
            <Text color={inkColors.error}>✗ </Text>
            <Text>{t.name}</Text>
            <Text dimColor>
              {'  '}
              waits on {String(t.blockedBy.length)} task{t.blockedBy.length !== 1 ? 's' : ''}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

function ProgressPanel({ entries }: { entries: readonly ProgressEntry[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>── Recent Progress ────────────────</Text>
      {entries.length === 0 ? (
        <Text dimColor>(no progress entries yet)</Text>
      ) : (
        entries.map((entry, i) => (
          <Box key={i} flexDirection="column" marginBottom={i < entries.length - 1 ? 1 : 0}>
            <Text bold dimColor>
              {entry.header}
            </Text>
            {entry.preview ? <Text>{entry.preview}</Text> : null}
          </Box>
        ))
      )}
    </Box>
  );
}

export function DashboardView(): React.JSX.Element {
  const { data, loading, error } = useDashboardData();
  const [progress, setProgress] = useState<readonly ProgressEntry[]>([]);

  useEffect(() => {
    if (!data) return;
    const cancel = { current: false };
    void (async () => {
      const entries = await loadRecentProgress(data.sprint.id, PROGRESS_TAIL_LIMIT);
      if (!cancel.current) setProgress(entries);
    })();
    return () => {
      cancel.current = true;
    };
  }, [data]);

  if (loading && !data) {
    return (
      <Box>
        <Text dimColor>Loading dashboard…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color={inkColors.error}>✗ {error}</Text>
      </Box>
    );
  }

  if (!data) {
    return (
      <Box flexDirection="column">
        <Text bold color={inkColors.primary}>
          Dashboard
        </Text>
        <Box marginTop={1}>
          <Text dimColor>No current sprint. Press </Text>
          <Text bold>h</Text>
          <Text dimColor> to return home and create one.</Text>
        </Box>
      </Box>
    );
  }

  const blocked = getBlockedTasks(data);
  const next = getNextAction(data);

  return (
    <Box flexDirection="column">
      <Hero data={data} />

      <Box marginTop={1}>
        <TaskGrid
          tasks={data.tasks}
          runningTaskIds={EMPTY_SET}
          blockedTaskIds={new Set(blocked.map((t) => t.id))}
          activityByTask={EMPTY_MAP}
        />
      </Box>

      <Box marginTop={1}>
        <BlockersPanel blocked={blocked} />
      </Box>

      <Box marginTop={1}>
        <ProgressPanel entries={progress} />
      </Box>

      {next ? (
        <Box marginTop={1}>
          <Text dimColor>Next: </Text>
          <Text color={inkColors.highlight}>{next.label}</Text>
          <Text dimColor>{` — ${next.description}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();
