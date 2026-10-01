/**
 * Task status glyph/colour tables shared by every task minimap, plus `TaskMinimap` — the passive TASKS list in Work's
 * glance column (glyph, name, and `blocked` / `waits on #N` / `running`).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphFor, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { computeListWindow, OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import type { TaskBucketStatus } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { Task } from '@src/domain/entity/task.ts';

// Exported so the blocked-status mapping is unit-testable apart from a render.
export const TASK_STATUS_GLYPH: Readonly<Record<TaskBucketStatus, string>> = {
  pending: glyphs.phasePending,
  running: glyphs.phaseActive,
  completed: glyphs.phaseDone,
  failed: glyphs.cross,
  aborted: glyphs.warningGlyph,
  skipped: glyphs.phaseDisabled,
  // The harness `blocked` triangle — a blocked row must never read as skip/pending.
  blocked: glyphFor('blocked'),
};

export const TASK_STATUS_COLOR: Readonly<Record<TaskBucketStatus, string>> = {
  pending: inkColors.muted,
  running: inkColors.info,
  completed: inkColors.success,
  failed: inkColors.error,
  aborted: inkColors.warning,
  skipped: inkColors.muted,
  blocked: inkColors.error,
};

export const truncateName = (name: string, maxChars: number): string =>
  name.length > maxChars ? `${name.slice(0, Math.max(0, maxChars - 1))}${glyphs.clipEllipsis}` : name;

const BUCKET_OF: Readonly<Record<Task['status'], TaskBucketStatus>> = {
  todo: 'pending',
  in_progress: 'running',
  done: 'completed',
  blocked: 'blocked',
};

const factOf = (task: Task, ordered: readonly Task[]): string | undefined => {
  if (task.status === 'in_progress') return 'running';
  if (task.status !== 'blocked') return undefined;
  if (task.blockKind === 'own') return 'blocked';
  const byId = new Map(ordered.map((t, i) => [t.id, i + 1] as const));
  const waitsOn = task.dependsOn.map((id) => byId.get(id)).find((n) => n !== undefined);
  return waitsOn !== undefined ? `waits on #${String(waitsOn)}` : 'blocked';
};

export interface TaskMinimapProps {
  readonly tasks: readonly Task[];
  /** Task rows shown before `▾ N more`. */
  readonly visibleRows: number;
  readonly width: number;
}

export const TaskMinimap = ({ tasks, visibleRows, width }: TaskMinimapProps): React.JSX.Element => {
  const ordered = [...tasks].sort((a, b) => a.order - b.order);
  if (ordered.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>no tasks yet</Text>
      </Box>
    );
  }
  // Keep the task that needs attention in view: the running one, else the first own-blocked.
  const anchor = Math.max(
    0,
    ordered.findIndex((t) => t.status === 'in_progress' || (t.status === 'blocked' && t.blockKind === 'own'))
  );
  const win = computeListWindow(ordered.length, anchor, visibleRows);
  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={win.hiddenAbove} />
      {ordered.slice(win.start, win.end).map((task) => {
        const status = BUCKET_OF[task.status];
        const fact = factOf(task, ordered);
        const nameBudget = Math.max(4, width - 2 * spacing.indent - 4 - (fact !== undefined ? fact.length + 1 : 0));
        return (
          <Box key={task.id} paddingX={spacing.indent} justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={TASK_STATUS_COLOR[status]}>{TASK_STATUS_GLYPH[status]}</Text>{' '}
              {truncateName(task.name, nameBudget)}
            </Text>
            {fact !== undefined && (
              <Box flexShrink={0} marginLeft={1}>
                <Text dimColor>{fact}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      <OverflowRow direction="below" count={win.hiddenBelow} />
    </Box>
  );
};
