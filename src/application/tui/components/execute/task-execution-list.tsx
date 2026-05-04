/**
 * TaskExecutionList — dependency-aware per-task card list.
 *
 * Each task renders as a small card showing:
 *   status-glyph  id-slice  StatusChip  name (truncated, 60 chars)
 *     ↳ current activity from latest signal (dim, truncated)
 *     ↳ depends on: task-X, task-Y   (only if blockedBy non-empty)
 *
 * Cards are ordered by dependency depth (topological BFS): root tasks
 * (no deps) first, then tasks that depend on roots, etc.  Within a depth
 * layer tasks are sorted by id for stability.  A per-depth left-indent
 * lets the eye trace the dependency chain.  Cycles fall back to insertion
 * order.
 *
 * This is the auto-fallback surface used by `<TaskExecutionGrid>` whenever
 * the task count exceeds the graph cap or the layout doesn't fit the
 * terminal width.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { computeDepths, getDepth, sortByDepth } from './dag-depth.ts';
import { activityFromSignal, type TaskGridItem } from './task-grid-item.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';

// ── Spinner hook (shared across all in-flight tasks) ─────────────────────────

function useSpinnerFrame(intervalMs = 90): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % glyphs.spinner.length);
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return frame;
}

// ── Status pill helpers ───────────────────────────────────────────────────────

export function statusColor(status: string): string {
  if (status === 'done') return inkColors.success;
  if (status === 'in_progress') return inkColors.warning;
  if (status === 'blocked') return inkColors.error;
  if (status === 'todo') return inkColors.muted;
  return inkColors.muted;
}

export function statusGlyph(status: string, spinnerFrame: number): string {
  if (status === 'done') return glyphs.phaseDone;
  if (status === 'in_progress') return glyphs.spinner[spinnerFrame] ?? glyphs.phaseActive;
  if (status === 'blocked') return glyphs.cross;
  return glyphs.phasePending;
}

export function statusLabel(status: string): string {
  if (status === 'done') return 'DONE';
  if (status === 'in_progress') return 'IN PROGRESS';
  if (status === 'blocked') return 'BLOCKED';
  if (status === 'todo') return 'TODO';
  return status.toUpperCase();
}

// ── Single task card ──────────────────────────────────────────────────────────

interface TaskCardProps {
  readonly task: TaskGridItem;
  readonly depth: number;
  readonly activityText: string | undefined;
  readonly taskNameLookup: Map<string, string> | null;
  readonly spinnerFrame: number;
}

const MAX_NAME_LEN = 60;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function TaskCard({ task, depth, activityText, taskNameLookup, spinnerFrame }: TaskCardProps): React.JSX.Element {
  const indentLeft = spacing.indent * depth;
  const color = statusColor(task.status);
  const glyph = statusGlyph(task.status, spinnerFrame);
  const label = statusLabel(task.status);
  const displayName = truncate(task.name, MAX_NAME_LEN);
  const idSlice = task.id.slice(0, 8);

  const depNames: string[] = task.blockedBy.slice(0, 4).map((depId) => {
    const name = taskNameLookup?.get(depId);
    return name !== undefined ? truncate(name, 20) : depId.slice(0, 8);
  });
  if (task.blockedBy.length > 4) depNames.push(`+${String(task.blockedBy.length - 4)} more`);

  return (
    <Box flexDirection="column" paddingLeft={indentLeft} marginTop={spacing.gutter}>
      {/* ── Main row: glyph · id · [status] · name ── */}
      <Box>
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text color={inkColors.muted}>{`  ${idSlice}  `}</Text>
        <Text color={color} bold>
          {`[${label}]`}
        </Text>
        <Text bold={task.status === 'in_progress'}>{`  ${displayName}`}</Text>
      </Box>

      {/* ── Activity line ── */}
      {activityText !== undefined && activityText.length > 0 ? (
        <Box paddingLeft={spacing.indent}>
          <Text color={inkColors.muted} dimColor>
            {`${glyphs.activityArrow} ${truncate(activityText, 100)}`}
          </Text>
        </Box>
      ) : null}

      {/* ── Blocked-by / depends-on line ── */}
      {task.blockedBy.length > 0 ? (
        <Box paddingLeft={spacing.indent}>
          <Text color={inkColors.muted} dimColor>
            {`${glyphs.activityArrow} depends on: ${depNames.join(', ')}`}
          </Text>
        </Box>
      ) : null}

      {/* ── Blocked reason ── */}
      {task.status === 'blocked' && task.blockedReason !== undefined && task.blockedReason.length > 0 ? (
        <Box paddingLeft={spacing.indent}>
          <Text color={inkColors.error} dimColor>
            {`${glyphs.cross} ${truncate(task.blockedReason, 100)}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export interface TaskExecutionListProps {
  readonly tasks: readonly TaskGridItem[] | null;
  readonly taskNameLookup: Map<string, string> | null;
  readonly taskSignals: ReadonlyMap<string, HarnessSignal> | null;
}

export function TaskExecutionList({
  tasks,
  taskNameLookup,
  taskSignals,
}: TaskExecutionListProps): React.JSX.Element | null {
  const spinnerFrame = useSpinnerFrame();

  if (tasks === null || tasks.length === 0) return null;

  const depths = computeDepths(tasks);
  const sorted = sortByDepth(tasks);

  return (
    <Box flexDirection="column">
      {sorted.map((task) => {
        const depth = getDepth(task, depths);
        const signal = taskSignals?.get(task.id);
        const activityText = signal !== undefined ? activityFromSignal(signal) : undefined;
        return (
          <TaskCard
            key={task.id}
            task={task}
            depth={depth}
            activityText={activityText}
            taskNameLookup={taskNameLookup}
            spinnerFrame={spinnerFrame}
          />
        );
      })}
    </Box>
  );
}
