/**
 * DagView — task dependency graph rendered as topological layers.
 *
 * Tasks group into levels: level 0 holds every task with no `blockedBy`
 * predecessors; each subsequent level holds tasks whose predecessors all
 * resolve in earlier levels. Within a level, nodes render side-by-side
 * separated by a thin gutter; between levels, a dim arrow row signals
 * dependency direction.
 *
 * Per-node visual encoding:
 *   - pending → dim ◇ glyph
 *   - running → spinner (animated braille frame)
 *   - done    → success ✓
 *   - failed  → error ✗
 *   - skipped → muted ◌ (skipped because a predecessor failed)
 *   - blocked → warning ⚠
 *
 * Tiny-terminal fallback: when the terminal width can't fit even the widest
 * level, the view degrades to a single-column list with a `…` truncation
 * indicator and a hint instructing the user to widen the terminal — never
 * crashes, never produces garbled output.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '@src/domain/models.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';

interface Props {
  readonly tasks: readonly Task[];
  /** Task IDs whose status the live signal stream marks as currently running. */
  readonly runningTaskIds?: ReadonlySet<string>;
  /** Task IDs that failed (terminal failure recorded by the executor). */
  readonly failedTaskIds?: ReadonlySet<string>;
  /** Task IDs that are blocked — predecessor still pending or evaluator gate failed. */
  readonly blockedTaskIds?: ReadonlySet<string>;
  /** Override terminal width — falls back to a sensible default in tests / non-TTY. */
  readonly terminalWidth?: number;
  /** Per-node visual width (chars). Adjusts how many fit per level. */
  readonly nodeWidth?: number;
}

export type DagNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'blocked';

const DEFAULT_NODE_WIDTH = 18;
const NODE_GUTTER = 2;
const FALLBACK_TERMINAL_WIDTH = 80;

/**
 * Group tasks into topological levels. Tasks with no `blockedBy` go into
 * level 0; subsequent levels collect tasks whose predecessors are all already
 * placed. A cycle would leave tasks unplaced — they fall through to a final
 * "orphans" level so the UI never silently drops them.
 *
 * Exported for unit testing.
 */
export function layerTasks(tasks: readonly Task[]): Task[][] {
  const remaining = new Map<string, Task>();
  for (const t of tasks) remaining.set(t.id, t);

  const levels: Task[][] = [];
  const placedIds = new Set<string>();

  while (remaining.size > 0) {
    const level: Task[] = [];
    for (const task of remaining.values()) {
      const ready = task.blockedBy.every((id) => placedIds.has(id) || !remaining.has(id));
      if (ready) level.push(task);
    }
    if (level.length === 0) {
      // Cycle / orphan — flush whatever's left as a final level so we don't
      // loop forever and so the user still sees the tasks.
      levels.push([...remaining.values()]);
      break;
    }
    level.sort((a, b) => a.order - b.order);
    levels.push(level);
    for (const t of level) {
      placedIds.add(t.id);
      remaining.delete(t.id);
    }
  }

  return levels;
}

export function statusForTask(
  task: Task,
  runningIds: ReadonlySet<string>,
  failedIds: ReadonlySet<string>,
  blockedIds: ReadonlySet<string>
): DagNodeStatus {
  if (failedIds.has(task.id)) return 'failed';
  if (task.status === 'skipped') return 'skipped';
  if (task.status === 'done') return 'done';
  if (blockedIds.has(task.id)) return 'blocked';
  if (runningIds.has(task.id) || task.status === 'in_progress') return 'running';
  return 'pending';
}

interface NodeDisplay {
  readonly glyph: string;
  readonly color: string;
  readonly dim: boolean;
}

function nodeDisplay(status: DagNodeStatus): NodeDisplay {
  switch (status) {
    case 'pending':
      return { glyph: glyphs.phasePending, color: inkColors.muted, dim: true };
    case 'running':
      return { glyph: '', color: inkColors.warning, dim: false };
    case 'done':
      return { glyph: glyphs.check, color: inkColors.success, dim: false };
    case 'failed':
      return { glyph: glyphs.cross, color: inkColors.error, dim: false };
    case 'skipped':
      return { glyph: glyphs.phaseDisabled, color: inkColors.muted, dim: true };
    case 'blocked':
      return { glyph: glyphs.warningGlyph, color: inkColors.warning, dim: false };
  }
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width, ' ');
  return value.slice(0, Math.max(0, width - 1)) + '…';
}

interface NodeProps {
  readonly task: Task;
  readonly status: DagNodeStatus;
  readonly width: number;
}

function DagNode({ task, status, width }: NodeProps): React.JSX.Element {
  const display = nodeDisplay(status);
  const labelWidth = Math.max(4, width - 2);
  const label = truncate(task.name, labelWidth);

  if (status === 'running') {
    return (
      <Box width={width}>
        <Spinner label={label} color={display.color} />
      </Box>
    );
  }

  return (
    <Box width={width}>
      <Text color={display.color} bold={!display.dim} dimColor={display.dim}>
        {display.glyph} {label}
      </Text>
    </Box>
  );
}

export function DagView(props: Props): React.JSX.Element {
  const {
    tasks,
    runningTaskIds = new Set<string>(),
    failedTaskIds = new Set<string>(),
    blockedTaskIds = new Set<string>(),
    terminalWidth = FALLBACK_TERMINAL_WIDTH,
    nodeWidth = DEFAULT_NODE_WIDTH,
  } = props;

  if (tasks.length === 0) {
    return (
      <Box>
        <Text dimColor>No tasks in this sprint yet.</Text>
      </Box>
    );
  }

  const levels = layerTasks(tasks);
  const perRow = Math.max(1, Math.floor((terminalWidth + NODE_GUTTER) / (nodeWidth + NODE_GUTTER)));
  const widestLevel = levels.reduce((acc, level) => Math.max(acc, level.length), 0);
  const tooNarrow = widestLevel > 1 && perRow < 2;

  if (tooNarrow) {
    // Tiny terminal — degrade gracefully to a flat list ordered by level.
    return (
      <Box flexDirection="column">
        <Text dimColor>(graph compressed — widen the terminal to see dependency layers)</Text>
        {levels.flat().map((task) => {
          const status = statusForTask(task, runningTaskIds, failedTaskIds, blockedTaskIds);
          return (
            <DagNode
              key={task.id}
              task={task}
              status={status}
              width={Math.min(nodeWidth, Math.max(8, terminalWidth - 2))}
            />
          );
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {levels.map((level, levelIndex) => (
        <Box key={`level-${String(levelIndex)}`} flexDirection="column">
          {levelIndex > 0 ? (
            <Text dimColor>
              {' '.repeat(Math.floor(nodeWidth / 2))}
              {glyphs.arrowRight}
            </Text>
          ) : null}
          <LevelRow
            level={level}
            perRow={perRow}
            nodeWidth={nodeWidth}
            runningIds={runningTaskIds}
            failedIds={failedTaskIds}
            blockedIds={blockedTaskIds}
          />
        </Box>
      ))}
      <Box marginTop={spacing.section}>
        <Text dimColor>
          {glyphs.check} done {glyphs.inlineDot} {glyphs.cross} failed {glyphs.inlineDot} {glyphs.warningGlyph} blocked{' '}
          {glyphs.inlineDot} {glyphs.phasePending} pending {glyphs.inlineDot} {glyphs.phaseDisabled} skipped
        </Text>
      </Box>
    </Box>
  );
}

interface LevelRowProps {
  readonly level: readonly Task[];
  readonly perRow: number;
  readonly nodeWidth: number;
  readonly runningIds: ReadonlySet<string>;
  readonly failedIds: ReadonlySet<string>;
  readonly blockedIds: ReadonlySet<string>;
}

function LevelRow({ level, perRow, nodeWidth, runningIds, failedIds, blockedIds }: LevelRowProps): React.JSX.Element {
  const rows: Task[][] = [];
  for (let i = 0; i < level.length; i += perRow) {
    rows.push(level.slice(i, i + perRow));
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Box key={`row-${String(rowIndex)}`}>
          {row.map((task, idx) => {
            const status = statusForTask(task, runningIds, failedIds, blockedIds);
            return (
              <Box key={task.id} marginRight={idx < row.length - 1 ? NODE_GUTTER : 0}>
                <DagNode task={task} status={status} width={nodeWidth} />
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
