/**
 * TaskExecutionGrid — DAG-ordered per-task card grid for the execute view.
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
 * order and emit a debug log.
 *
 * Data flows entirely via props — no internal subscriptions.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';

// ── Task descriptor ─────────────────────────────────────────────────────────

/**
 * Minimal duck-typed task shape required by the grid.  The full Task entity
 * from `src/domain/entities/task.ts` satisfies this interface but we avoid
 * a hard import so the component stays decoupled from the entity layer.
 */
export interface TaskGridItem {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly blockedBy: readonly string[];
  readonly projectPath: string;
  readonly blockedReason?: string | undefined;
}

// ── DAG layering ─────────────────────────────────────────────────────────────

/**
 * Assign each task a depth using BFS from roots (tasks with no dependencies).
 * `depth = 1 + max(dep.depth)` for each task.
 *
 * Returns null (cycle detected) or a Map<taskId, depth>.
 * On cycle: logs a debug message and returns null so the caller falls back
 * to insertion order.
 */
function computeDepths(tasks: readonly TaskGridItem[]): Map<string, number> | null {
  const idSet = new Set(tasks.map((t) => t.id));
  // Build adjacency: id → [dep ids that are present in this list]
  const deps = new Map<string, string[]>();
  for (const t of tasks) {
    deps.set(
      t.id,
      t.blockedBy.filter((d) => idSet.has(d))
    );
  }

  const depths = new Map<string, number>();
  const inProgress = new Set<string>(); // cycle detection

  function visit(id: string): number | null {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return null; // cycle
    inProgress.add(id);
    const taskDeps = deps.get(id) ?? [];
    let maxDepth = -1;
    for (const dep of taskDeps) {
      const d = visit(dep);
      if (d === null) return null; // propagate cycle
      if (d > maxDepth) maxDepth = d;
    }
    inProgress.delete(id);
    const myDepth = maxDepth + 1;
    depths.set(id, myDepth);
    return myDepth;
  }

  for (const t of tasks) {
    const result = visit(t.id);
    if (result === null) return null; // cycle detected
  }
  return depths;
}

/**
 * Sort tasks by dependency depth (ascending), then by id within each layer.
 * Falls back to insertion order when cycles are detected.
 */
export function sortByDepth(tasks: readonly TaskGridItem[]): readonly TaskGridItem[] {
  const depths = computeDepths(tasks);
  if (depths === null) {
    // Cycle fallback — insertion order
    return [...tasks];
  }
  return [...tasks].sort((a, b) => {
    const da = depths.get(a.id) ?? 0;
    const db = depths.get(b.id) ?? 0;
    if (da !== db) return da - db;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function getDepth(task: TaskGridItem, depths: Map<string, number> | null): number {
  return depths?.get(task.id) ?? 0;
}

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

function statusColor(status: string): string {
  if (status === 'done') return inkColors.success;
  if (status === 'in_progress') return inkColors.warning;
  if (status === 'blocked') return inkColors.error;
  if (status === 'todo') return inkColors.muted;
  return inkColors.muted;
}

function statusGlyph(status: string, spinnerFrame: number): string {
  if (status === 'done') return glyphs.phaseDone;
  if (status === 'in_progress') return glyphs.spinner[spinnerFrame] ?? glyphs.phaseActive;
  if (status === 'blocked') return glyphs.cross;
  return glyphs.phasePending;
}

function statusLabel(status: string): string {
  if (status === 'done') return 'DONE';
  if (status === 'in_progress') return 'IN PROGRESS';
  if (status === 'blocked') return 'BLOCKED';
  if (status === 'todo') return 'TODO';
  return status.toUpperCase();
}

// ── Activity text from a signal ───────────────────────────────────────────────

/**
 * Derive a short human-readable activity string from the most recent signal
 * emitted for this task.  Handles every variant in the HarnessSignal union;
 * non-progress variants that aren't interesting to display just return ''.
 */
function activityFromSignal(signal: HarnessSignal): string {
  switch (signal.type) {
    case 'progress':
      return signal.summary.slice(0, 100);
    case 'note':
      return `note: ${signal.text.slice(0, 90)}`;
    case 'task-verified':
      return `verified: ${signal.output.slice(0, 80)}`;
    case 'task-complete':
      return 'task complete';
    case 'task-blocked':
      return `blocked: ${signal.reason.slice(0, 90)}`;
    case 'evaluation':
      return `evaluation: ${signal.status}`;
    case 'check-script-discovery':
    case 'agents-md-proposal':
    case 'setup-script':
    case 'verify-script':
    case 'skill-suggestions':
      return '';
  }
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

// ── Grid ─────────────────────────────────────────────────────────────────────

export interface TaskExecutionGridProps {
  /**
   * Full task list from the runner's ctx (populated after `load-tasks`).
   * When null (chain hasn't reached that step yet), the grid renders nothing.
   */
  readonly tasks: readonly TaskGridItem[] | null;
  /**
   * Optional id → name lookup for rendering dep names in the "depends on" line.
   * When null the dep ids are shown truncated instead.
   */
  readonly taskNameLookup: Map<string, string> | null;
  /**
   * Map of taskId → latest HarnessSignal emitted for that task.
   * When null (test environments without a bus) the activity line is hidden.
   */
  readonly taskSignals: ReadonlyMap<string, HarnessSignal> | null;
}

export function TaskExecutionGrid({
  tasks,
  taskNameLookup,
  taskSignals,
}: TaskExecutionGridProps): React.JSX.Element | null {
  const spinnerFrame = useSpinnerFrame();

  if (tasks === null || tasks.length === 0) return null;

  const depths = computeDepths(tasks);
  const sorted = sortByDepth(tasks);

  return (
    <Box flexDirection="column" marginTop={spacing.section}>
      <Text dimColor bold>
        {glyphs.activityArrow} Task execution
      </Text>
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
