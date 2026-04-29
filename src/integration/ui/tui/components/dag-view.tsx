/**
 * DagView — task dependency graph rendered as topological waves.
 *
 * Tasks group into levels (waves): wave 0 holds every task with no `blockedBy`
 * predecessors; each subsequent wave holds tasks whose predecessors all
 * resolve in earlier waves. Each wave gets a labelled separator row so the
 * boundary is unmistakable even when a wave wraps to multiple sub-rows.
 *
 * Per-node visual encoding:
 *   - pending → dim ◇ glyph
 *   - running → spinner (animated braille frame) + activity tail
 *   - done    → success ✓
 *   - failed  → error ✗
 *   - skipped → muted ◌ (skipped because a predecessor failed)
 *   - blocked → warning ⚠
 *
 * Layout rules:
 *   - Node width is computed from the terminal width so labels grow on wide
 *     terminals instead of being permanently truncated to 18 chars.
 *   - When the total rendered height exceeds `maxRows`, trailing waves are
 *     collapsed into a `… +N more wave(s)` summary so the section never
 *     pushes the log tail off-screen.
 *   - Tiny terminals (where even the widest wave can't fit two columns)
 *     degrade to a single-column list with a hint — never crashes, never
 *     produces garbled output.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Task } from '@src/domain/models.ts';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';

interface Props {
  readonly tasks: readonly Task[];
  /** Task IDs whose status the live signal stream marks as currently running. */
  readonly runningTaskIds?: ReadonlySet<string>;
  /** Task IDs that failed (terminal failure recorded by the executor). */
  readonly failedTaskIds?: ReadonlySet<string>;
  /** Task IDs that are blocked — predecessor still pending or evaluator gate failed. */
  readonly blockedTaskIds?: ReadonlySet<string>;
  /** Per-task activity string (latest progress summary). Shown under running nodes. */
  readonly activityByTask?: ReadonlyMap<string, string>;
  /** Override terminal width — falls back to a sensible default in tests / non-TTY. */
  readonly terminalWidth?: number;
  /** Maximum rows the section is allowed to occupy. Trailing waves collapse. */
  readonly maxRows?: number;
}

export type DagNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'blocked';

const MIN_NODE_WIDTH = 16;
const MAX_NODE_WIDTH = 36;
const NODE_GUTTER = 2;
const FALLBACK_TERMINAL_WIDTH = 80;
const DEFAULT_MAX_ROWS = 14;

/**
 * Group tasks into topological waves. Tasks with no `blockedBy` go into
 * wave 0; subsequent waves collect tasks whose predecessors are all already
 * placed. A cycle would leave tasks unplaced — they fall through to a final
 * "orphans" wave so the UI never silently drops them.
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

/**
 * Pick a node width that fits the wave with the most tasks neatly into the
 * terminal width. We bias toward wider nodes (better readability) when the
 * widest wave is small enough to allow it, and shrink only when packing more
 * tasks per row demands it. Bounded by MIN/MAX so a single very wide
 * terminal doesn't produce gigantic empty cells.
 *
 * Exported for unit testing.
 */
export function computeNodeWidth(terminalWidth: number, widestWaveSize: number): number {
  if (widestWaveSize <= 0) return MIN_NODE_WIDTH;
  // How many nodes per row we'd need at MIN_NODE_WIDTH? If even that doesn't
  // fit one node, return MIN_NODE_WIDTH and let the tiny-terminal branch
  // handle the layout.
  const usable = Math.max(0, terminalWidth);
  const perRowAtMin = Math.max(1, Math.floor((usable + NODE_GUTTER) / (MIN_NODE_WIDTH + NODE_GUTTER)));
  // Aim to render the widest wave in as few rows as possible while still
  // giving each node breathing room.
  const targetPerRow = Math.min(widestWaveSize, perRowAtMin);
  if (targetPerRow <= 0) return MIN_NODE_WIDTH;
  const rawWidth = Math.floor((usable - NODE_GUTTER * (targetPerRow - 1)) / targetPerRow);
  const clamped = Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, rawWidth));
  return clamped;
}

interface NodeProps {
  readonly task: Task;
  readonly status: DagNodeStatus;
  readonly width: number;
  readonly activity?: string;
}

function DagNode({ task, status, width, activity }: NodeProps): React.JSX.Element {
  const display = nodeDisplay(status);
  const labelWidth = Math.max(4, width - 2);
  const label = truncate(task.name, labelWidth);

  if (status === 'running') {
    return (
      <Box width={width} flexDirection="column">
        <Spinner label={label} color={display.color} />
        {activity ? (
          <Text color={inkColors.info} italic dimColor>
            {' '}
            {glyphs.activityArrow} {truncate(activity, Math.max(8, width - 3))}
          </Text>
        ) : null}
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

interface WaveSeparatorProps {
  readonly index: number;
  readonly count: number;
  readonly summary: string;
  readonly width: number;
}

function WaveSeparator({ index, count, summary, width }: WaveSeparatorProps): React.JSX.Element {
  const label = ` wave ${String(index + 1)} · ${String(count)} task${count === 1 ? '' : 's'}${summary ? ' · ' + summary : ''} `;
  const remaining = Math.max(0, width - label.length - 4);
  const left = '── ';
  const right = ' ' + '─'.repeat(remaining) + '──';
  return (
    <Text color={inkColors.muted} dimColor>
      {left}
      <Text color={inkColors.info} bold={false}>
        {label.trim()}
      </Text>
      {right}
    </Text>
  );
}

function summariseWave(
  tasks: readonly Task[],
  runningIds: ReadonlySet<string>,
  failedIds: ReadonlySet<string>
): string {
  let done = 0;
  let running = 0;
  let failed = 0;
  for (const t of tasks) {
    if (failedIds.has(t.id)) failed++;
    else if (t.status === 'done') done++;
    else if (runningIds.has(t.id) || t.status === 'in_progress') running++;
  }
  const parts: string[] = [];
  if (done > 0) parts.push(`${String(done)} done`);
  if (running > 0) parts.push(`${String(running)} running`);
  if (failed > 0) parts.push(`${String(failed)} failed`);
  return parts.join(', ');
}

export function DagView(props: Props): React.JSX.Element {
  const {
    tasks,
    runningTaskIds = new Set<string>(),
    failedTaskIds = new Set<string>(),
    blockedTaskIds = new Set<string>(),
    activityByTask,
    terminalWidth = FALLBACK_TERMINAL_WIDTH,
    maxRows = DEFAULT_MAX_ROWS,
  } = props;

  if (tasks.length === 0) {
    return (
      <Box>
        <Text dimColor>No tasks in this sprint yet.</Text>
      </Box>
    );
  }

  const levels = layerTasks(tasks);
  const widestLevel = levels.reduce((acc, level) => Math.max(acc, level.length), 0);
  const nodeWidth = computeNodeWidth(terminalWidth, widestLevel);
  const perRow = Math.max(1, Math.floor((terminalWidth + NODE_GUTTER) / (nodeWidth + NODE_GUTTER)));
  const tooNarrow = widestLevel > 1 && perRow < 2;

  if (tooNarrow) {
    return (
      <Box flexDirection="column">
        <Text dimColor>(graph compressed — widen the terminal to see dependency waves)</Text>
        {levels.flat().map((task) => {
          const status = statusForTask(task, runningTaskIds, failedTaskIds, blockedTaskIds);
          return (
            <DagNode
              key={task.id}
              task={task}
              status={status}
              width={Math.min(nodeWidth, Math.max(8, terminalWidth - 2))}
              activity={activityByTask?.get(task.id)}
            />
          );
        })}
      </Box>
    );
  }

  // Pre-compute the row cost of each wave so we can decide how many waves
  // fit inside `maxRows`. Each wave costs: 1 separator + ceil(size / perRow) node rows.
  const waveCosts = levels.map((level) => 1 + Math.ceil(level.length / perRow));

  let rowsUsed = 0;
  let visibleWaveCount = 0;
  for (const cost of waveCosts) {
    if (rowsUsed + cost > maxRows && visibleWaveCount > 0) break;
    rowsUsed += cost;
    visibleWaveCount++;
  }
  const hiddenWaveCount = levels.length - visibleWaveCount;

  return (
    <Box flexDirection="column">
      {levels.slice(0, visibleWaveCount).map((level, levelIndex) => {
        const summary = summariseWave(level, runningTaskIds, failedTaskIds);
        return (
          <Box key={`level-${String(levelIndex)}`} flexDirection="column">
            <WaveSeparator index={levelIndex} count={level.length} summary={summary} width={terminalWidth} />
            <LevelRow
              level={level}
              perRow={perRow}
              nodeWidth={nodeWidth}
              runningIds={runningTaskIds}
              failedIds={failedTaskIds}
              blockedIds={blockedTaskIds}
              activityByTask={activityByTask}
            />
          </Box>
        );
      })}
      {hiddenWaveCount > 0 ? (
        <Text color={inkColors.muted} dimColor>
          {'  '}
          {glyphs.inlineDot} {String(hiddenWaveCount)} more wave{hiddenWaveCount === 1 ? '' : 's'} hidden — widen the
          terminal or finish earlier waves to reveal
        </Text>
      ) : null}
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
  readonly activityByTask?: ReadonlyMap<string, string>;
}

function LevelRow({
  level,
  perRow,
  nodeWidth,
  runningIds,
  failedIds,
  blockedIds,
  activityByTask,
}: LevelRowProps): React.JSX.Element {
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
                <DagNode task={task} status={status} width={nodeWidth} activity={activityByTask?.get(task.id)} />
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
