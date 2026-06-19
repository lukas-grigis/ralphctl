/**
 * ImplementSidebar — left sidebar for the redesigned Implement view (≥140 col breakpoint).
 *
 * Section order (top → bottom):
 *
 *   1. BaselineHealthCard — bordered card at the top of the sidebar (not a chip). Shows the
 *      harness verify-gate data (setup, pre/post verify, attribution).
 *   2. Flow-steps rail — reuses `FlowStepsRail` verbatim. Compact/suppressed (`suppressMeta`)
 *      when the sidebar is narrow; capped at `sidebarFlowStepsRows`.
 *   3. Task nav list — PASSIVE minimap: highlights the card focused in the main area. No keyboard
 *      capture — the main-area TasksPanel is the sole input owner and reports its cursor via
 *      `focusedTaskId`. The list scrolls to keep the highlighted row visible.
 *   4. TokenBudgetCard at the bottom — shows cumulative token usage (honest claude-p style: raw
 *      totals when cumulative, context bar when plausible single-call).
 *
 * Width is fixed at `sidebarWidth` columns — never `flexGrow`. The sidebar column height is
 * bounded by the terminal rows (managed via the windowed task-nav list and fixed component
 * heights).
 *
 * Visual discipline:
 *   - All colours from `inkColors.*`, all glyphs from `glyphs.*`, all spacing from `spacing.*`.
 *   - Section separators: a single dim `─` rule of `sidebarWidth - 2` chars (matching the
 *     style of the Card component's border), wrapped in a 1-padding Box.
 *   - Section headers: `dimColor bold` bullet + title, matching `SectionHeader` from
 *     `section.tsx`.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { CONTEXT_WIDTH, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { TokenBudgetCard } from '@src/application/ui/tui/components/token-budget-card.tsx';
import { BaselineHealthCard } from '@src/application/ui/tui/components/baseline-health-card.tsx';
import { FlowStepsRail } from '@src/application/ui/tui/views/execute-view-internals/rail.tsx';
import { SectionHeader } from '@src/application/ui/tui/views/execute-view-internals/section.tsx';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type {
  BucketedExecution,
  TaskBucket,
  TaskBucketStatus,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

// ---------------------------------------------------------------------------
// Status glyph + colour for the task-nav list rows
// ---------------------------------------------------------------------------

const TASK_STATUS_GLYPH: Readonly<Record<TaskBucketStatus, string>> = {
  pending: glyphs.phasePending,
  running: glyphs.phaseActive,
  completed: glyphs.phaseDone,
  failed: glyphs.cross,
  aborted: glyphs.warningGlyph,
  skipped: glyphs.phaseDisabled,
};

const TASK_STATUS_COLOR: Readonly<Record<TaskBucketStatus, string>> = {
  pending: inkColors.muted,
  running: inkColors.info,
  completed: inkColors.success,
  failed: inkColors.error,
  aborted: inkColors.warning,
  skipped: inkColors.muted,
};

// ---------------------------------------------------------------------------
// Section divider
// ---------------------------------------------------------------------------

const SidebarDivider = ({ width }: { readonly width: number }): React.JSX.Element => (
  <Box paddingX={1} marginTop={spacing.gutter}>
    <Text color={inkColors.rule}>{glyphs.sectionRule.repeat(Math.max(0, width - 2))}</Text>
  </Box>
);

// ---------------------------------------------------------------------------
// Task nav list — PASSIVE minimap
// ---------------------------------------------------------------------------

interface TaskNavListProps {
  readonly tasks: readonly TaskBucket[];
  readonly nameById: ReadonlyMap<string, string> | undefined;
  readonly visibleRows: number;
  /** Id of the card currently focused in the main-area TasksPanel. */
  readonly focusedTaskId: string | undefined;
  readonly sidebarWidth: number;
}

/** Truncate a display name to fit within the nav row width. */
const truncateName = (name: string, maxChars: number): string =>
  name.length > maxChars ? `${name.slice(0, Math.max(0, maxChars - 1))}${glyphs.clipEllipsis}` : name;

const TaskNavList = ({
  tasks,
  nameById,
  visibleRows,
  focusedTaskId,
  sidebarWidth,
}: TaskNavListProps): React.JSX.Element => {
  // Pure windowing math — no keyboard capture. Centre the window on the focused row.
  const focusedIndex = focusedTaskId !== undefined ? tasks.findIndex((t) => t.id === focusedTaskId) : -1;
  const totalTasks = tasks.length;
  const effectiveStart =
    focusedIndex >= 0
      ? Math.min(Math.max(0, focusedIndex - Math.floor(visibleRows / 2)), Math.max(0, totalTasks - visibleRows))
      : 0;
  const effectiveEnd = Math.min(totalTasks, effectiveStart + visibleRows);
  const hiddenAbove = effectiveStart;
  const hiddenBelow = totalTasks - effectiveEnd;
  const visibleSlice = tasks.slice(effectiveStart, effectiveEnd);

  if (tasks.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>no tasks yet</Text>
      </Box>
    );
  }

  // Each row: [n] shortTitle · statusGlyph
  // width budget: sidebarWidth - 2 (paddingX) - 4 (index "[n] ") - 3 (" · G") = sidebarWidth - 9
  const nameBudget = Math.max(4, sidebarWidth - 9);

  return (
    <Box flexDirection="column">
      <OverflowRow direction="above" count={hiddenAbove} />
      {visibleSlice.map((task, localIdx) => {
        const absoluteIndex = effectiveStart + localIdx;
        const isHighlighted = task.id === focusedTaskId;
        const rawName = nameById?.get(task.id) ?? `${task.id.slice(0, 8)}${glyphs.clipEllipsis}`;
        const display = truncateName(rawName, nameBudget);
        const glyph = TASK_STATUS_GLYPH[task.status];
        const color = TASK_STATUS_COLOR[task.status];
        const n = absoluteIndex + 1;

        return (
          <Box key={task.id} paddingX={spacing.indent}>
            {/* Minimap highlight cursor — follows the main-area card cursor */}
            <Text color={isHighlighted ? inkColors.highlight : inkColors.muted}>
              {isHighlighted ? glyphs.actionCursor : glyphs.bullet}
            </Text>
            <Text> </Text>
            {/* Index */}
            <Text dimColor>{String(n)}</Text>
            <Text> </Text>
            {/* Short title */}
            <Text bold={isHighlighted}>{display}</Text>
            {/* Status glyph */}
            <Text dimColor> {glyphs.inlineDot} </Text>
            <Text color={color}>{glyph}</Text>
          </Box>
        );
      })}
      <OverflowRow direction="below" count={hiddenBelow} />
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ImplementSidebarProps {
  /** Fixed column width for the sidebar — never flexGrow. */
  readonly sidebarWidth: number;
  /** How many task-nav rows to show before the list scrolls. */
  readonly sidebarTaskNavRows: number;
  /** Max rows for the flow-steps rail — derived from terminal height. */
  readonly sidebarFlowStepsRows: number;
  /**
   * When true, render BaselineHealthCard and TokenBudgetCard side by side in one horizontal
   * row instead of stacking them. True at ≥xl (180 cols) — the sidebar is wide enough to fit
   * two CONTEXT_WIDTH (28) cards with room to spare. Reclaims vertical space for the log panel.
   */
  readonly sidebarContextSideBySide: boolean;
  /** Session / sprint / model info from the session manager. */
  readonly descriptor: SessionDescriptor;
  /** Bucketed task execution state — undefined while the harness hasn't emitted any events. */
  readonly bucketed: BucketedExecution | undefined;
  /** Whether the run is still in flight (drives status glyph + spinner). */
  readonly isRunning: boolean;
  /**
   * Id of the card currently focused in the main-area TasksPanel. The task-nav list highlights
   * this row and scrolls to keep it visible. `undefined` when no card has been explicitly focused
   * yet (the panel auto-focuses the active task before reporting).
   */
  readonly focusedTaskId: string | undefined;
  /**
   * Token usage for the current session — rendered in the TokenBudgetCard at the bottom of the
   * sidebar. Undefined until the first TokenUsageEvent fires (the card renders an empty-state
   * placeholder so the operator sees the slot is live).
   */
  readonly tokenUsage?: TokenUsage;
  /**
   * Sprint execution state — feeds the BaselineHealthCard at the top of the sidebar.
   * Undefined when the pinned sprint is stale or not yet loaded.
   */
  readonly executionState?: SprintExecution;
  /**
   * Task list — feeds the BaselineHealthCard (verify-run derivation + attribution counts).
   * Undefined until the first baseline-health poll resolves.
   */
  readonly taskState?: readonly Task[];
  /** Wall-clock timestamp — passed to the BaselineHealthCard for "N ago" labels. */
  readonly now: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ImplementSidebar = ({
  sidebarWidth,
  sidebarTaskNavRows,
  sidebarFlowStepsRows,
  sidebarContextSideBySide,
  descriptor,
  bucketed,
  isRunning,
  focusedTaskId,
  tokenUsage,
  executionState,
  taskState,
  now,
}: ImplementSidebarProps): React.JSX.Element => {
  // Stabilize the array reference: a fresh `[]` (or even the same tasks behind a new `bucketed`) each
  // render would defeat TaskNavList's memoization. Keyed on `bucketed` so it only churns when the
  // bucketed snapshot actually changes.
  const tasks = useMemo(() => bucketed?.tasks ?? [], [bucketed]);
  const nameById = descriptor.taskNames;

  // Each card gets CONTEXT_WIDTH cols in the side-by-side row. In the stacked layout the
  // baseline card fills the sidebar width minus the inner padding.
  const baselineCardWidth = sidebarContextSideBySide ? CONTEXT_WIDTH : sidebarWidth - spacing.indent;

  return (
    <Box flexDirection="column" width={sidebarWidth} flexShrink={0}>
      {/* ── 1. Baseline + Token cards — side-by-side at ≥xl, stacked below ─ */}
      {sidebarContextSideBySide ? (
        /* Side-by-side row: Baseline | Token — each CONTEXT_WIDTH cols wide. */
        <Box flexDirection="row" marginTop={spacing.gutter}>
          <BaselineHealthCard
            {...(executionState !== undefined ? { execution: executionState } : {})}
            {...(taskState !== undefined ? { tasks: taskState } : {})}
            now={now}
            width={baselineCardWidth}
          />
          <Box marginLeft={spacing.gutter}>
            <TokenBudgetCard sessionId={descriptor.id} {...(tokenUsage !== undefined ? { usage: tokenUsage } : {})} />
          </Box>
        </Box>
      ) : (
        /* Stacked layout: Baseline on top, Token at the bottom after Steps + Tasks. */
        <Box marginTop={spacing.gutter}>
          <BaselineHealthCard
            {...(executionState !== undefined ? { execution: executionState } : {})}
            {...(taskState !== undefined ? { tasks: taskState } : {})}
            now={now}
            width={baselineCardWidth}
          />
        </Box>
      )}

      {/* ── 2. Flow-steps rail ───────────────────────────────────────────── */}
      {sidebarFlowStepsRows > 0 && (
        <>
          <SidebarDivider width={sidebarWidth} />
          <SectionHeader title="Steps" />
          <Box marginTop={spacing.gutter}>
            <FlowStepsRail
              descriptor={descriptor}
              isRunning={isRunning}
              maxRows={sidebarFlowStepsRows}
              railWidth={sidebarWidth - spacing.indent}
              suppressMeta
            />
          </Box>
        </>
      )}

      {/* ── 3. Task nav list (passive minimap) ───────────────────────────── */}
      <SidebarDivider width={sidebarWidth} />
      <SectionHeader title="Tasks" />
      <Box marginTop={spacing.gutter}>
        <TaskNavList
          tasks={tasks}
          nameById={nameById}
          visibleRows={sidebarTaskNavRows}
          focusedTaskId={focusedTaskId}
          sidebarWidth={sidebarWidth}
        />
      </Box>

      {/* ── 4. TokenBudgetCard — stacked layout only (side-by-side handles it above) ── */}
      {!sidebarContextSideBySide && (
        <>
          <SidebarDivider width={sidebarWidth} />
          <Box marginTop={spacing.gutter}>
            <TokenBudgetCard sessionId={descriptor.id} {...(tokenUsage !== undefined ? { usage: tokenUsage } : {})} />
          </Box>
        </>
      )}
    </Box>
  );
};
