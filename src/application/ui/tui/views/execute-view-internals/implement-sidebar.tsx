/**
 * ImplementSidebar — left sidebar for the Implement view (≥140 col breakpoint): baseline health card, flow-steps rail,
 * a passive task minimap (the TasksPanel owns input), then the token budget card. Width is fixed at `sidebarWidth`.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { CONTEXT_WIDTH, glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import {
  TASK_STATUS_COLOR,
  TASK_STATUS_GLYPH,
  truncateName,
} from '@src/application/ui/tui/components/task-minimap.tsx';
import { OverflowRow } from '@src/application/ui/tui/components/windowed-list.tsx';
import { TokenBudgetCard } from '@src/application/ui/tui/components/token-budget-card.tsx';
import { BaselineHealthCard } from '@src/application/ui/tui/components/baseline-health-card.tsx';
import { FlowStepsRail } from '@src/application/ui/tui/views/execute-view-internals/rail.tsx';
import { SectionHeader } from '@src/application/ui/tui/views/execute-view-internals/section.tsx';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { overlayEntityBlockedStatus } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const SidebarDivider = ({ width }: { readonly width: number }): React.JSX.Element => (
  <Box paddingX={spacing.gutter} marginTop={spacing.gutter}>
    <Text color={inkColors.rule}>{glyphs.sectionRule.repeat(Math.max(0, width - 2))}</Text>
  </Box>
);

interface TaskNavListProps {
  readonly tasks: readonly TaskBucket[];
  readonly nameById: ReadonlyMap<string, string> | undefined;
  readonly visibleRows: number;
  /** Id of the card currently focused in the main-area TasksPanel. */
  readonly focusedTaskId: string | undefined;
  readonly sidebarWidth: number;
}

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

export interface ImplementSidebarProps {
  /** Fixed column width for the sidebar — never flexGrow. */
  readonly sidebarWidth: number;
  /** How many task-nav rows to show before the list scrolls. */
  readonly sidebarTaskNavRows: number;
  /** Max rows for the flow-steps rail — derived from terminal height. */
  readonly sidebarFlowStepsRows: number;
  /**
   * When true, render BaselineHealthCard and TokenBudgetCard side by side in one horizontal row instead of stacking
   * them.
   */
  readonly sidebarContextSideBySide: boolean;
  /** Session / sprint / model info from the session manager. */
  readonly descriptor: SessionDescriptor;
  /** Bucketed task execution state — undefined while the harness hasn't emitted any events. */
  readonly bucketed: BucketedExecution | undefined;
  /** Whether the run is still in flight (drives status glyph + spinner). */
  readonly isRunning: boolean;
  /**
   * Id of the card currently focused in the main-area TasksPanel. The task-nav list highlights this row and scrolls
   * to keep it visible.
   */
  readonly focusedTaskId: string | undefined;
  /** Token usage for the current session — rendered in the TokenBudgetCard at the bottom of the sidebar. */
  readonly tokenUsage?: TokenUsage;
  /**
   * Sprint execution state — feeds the BaselineHealthCard at the top of the sidebar. Undefined when the pinned sprint
   * is stale or not yet loaded.
   */
  readonly executionState?: SprintExecution;
  /**
   * Task list — feeds the BaselineHealthCard (verify-run derivation + attribution counts). Undefined until the first
   * baseline-health poll resolves.
   */
  readonly taskState?: readonly Task[];
  /** Wall-clock timestamp — passed to the BaselineHealthCard for "N ago" labels. */
  readonly now: number;
}

/** Cumulative token usage for the session. Rendered at the top or the bottom depending on regime. */
const SidebarTokenCard = ({
  sessionId,
  tokenUsage,
}: {
  readonly sessionId: string;
  readonly tokenUsage: TokenUsage | undefined;
}): React.JSX.Element => (
  <TokenBudgetCard sessionId={sessionId} {...(tokenUsage !== undefined ? { usage: tokenUsage } : {})} />
);

/** Baseline-health (+ token, at ≥xl) cards at the top of the sidebar. */
const SidebarContextCards = ({
  sideBySide,
  sidebarWidth,
  sessionId,
  executionState,
  taskState,
  tokenUsage,
  now,
}: {
  readonly sideBySide: boolean;
  readonly sidebarWidth: number;
  readonly sessionId: string;
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly tokenUsage: TokenUsage | undefined;
  readonly now: number;
}): React.JSX.Element => {
  const baselineCard = (
    <BaselineHealthCard
      {...(executionState !== undefined ? { execution: executionState } : {})}
      {...(taskState !== undefined ? { tasks: taskState } : {})}
      now={now}
      width={sideBySide ? CONTEXT_WIDTH : sidebarWidth - spacing.indent}
    />
  );
  if (!sideBySide) return <Box marginTop={spacing.gutter}>{baselineCard}</Box>;
  return (
    <Box flexDirection="row" marginTop={spacing.gutter}>
      {baselineCard}
      <Box marginLeft={spacing.gutter}>
        <SidebarTokenCard sessionId={sessionId} tokenUsage={tokenUsage} />
      </Box>
    </Box>
  );
};

/** Flow-steps rail section. Self-gates: dropped entirely when the terminal has no rows to spare. */
const SidebarStepsSection = ({
  descriptor,
  isRunning,
  sidebarWidth,
  sidebarFlowStepsRows,
}: {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly sidebarWidth: number;
  readonly sidebarFlowStepsRows: number;
}): React.JSX.Element | null => {
  if (sidebarFlowStepsRows <= 0) return null;
  return (
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
  );
};

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
  // Stabilize the array reference: a fresh `[]` (or even the same tasks behind a new `bucketed`) each render would
  // defeat TaskNavList's memoization.
  const tasks = useMemo(
    () => (bucketed !== undefined ? overlayEntityBlockedStatus(bucketed, taskState, isRunning).tasks : []),
    [bucketed, taskState, isRunning]
  );

  return (
    <Box flexDirection="column" width={sidebarWidth} flexShrink={0}>
      <SidebarContextCards
        sideBySide={sidebarContextSideBySide}
        sidebarWidth={sidebarWidth}
        sessionId={descriptor.id}
        executionState={executionState}
        taskState={taskState}
        tokenUsage={tokenUsage}
        now={now}
      />

      <SidebarStepsSection
        descriptor={descriptor}
        isRunning={isRunning}
        sidebarWidth={sidebarWidth}
        sidebarFlowStepsRows={sidebarFlowStepsRows}
      />

      {/* Task nav list (passive minimap) */}
      <SidebarDivider width={sidebarWidth} />
      <SectionHeader title="Tasks" />
      <Box marginTop={spacing.gutter}>
        <TaskNavList
          tasks={tasks}
          nameById={descriptor.taskNames}
          visibleRows={sidebarTaskNavRows}
          focusedTaskId={focusedTaskId}
          sidebarWidth={sidebarWidth}
        />
      </Box>

      {/* Token card — stacked layout only; the side-by-side regime renders it at the top. */}
      {!sidebarContextSideBySide && (
        <>
          <SidebarDivider width={sidebarWidth} />
          <Box marginTop={spacing.gutter}>
            <SidebarTokenCard sessionId={descriptor.id} tokenUsage={tokenUsage} />
          </Box>
        </>
      )}
    </Box>
  );
};
