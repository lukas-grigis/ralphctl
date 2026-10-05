/**
 * Responsive layout switcher for the execute view's main body — rail / tasks / context
 * column composition that adapts to the terminal width. Four regimes:
 *
 *   ≥180 cols (xl+):  three-column — fluid-width rail (resolveRailWidth) + flex Tasks + fixed
 *                     context column (BaselineHealthCard + TokenBudgetCard).
 *   140–179 cols:     two-column — fixed RAIL_WIDTH rail + flex Tasks. No context column.
 *   100–139 cols:     compact — full-width Tasks; the header strip carries the main steps. A
 *                     flow without task work items shows a full-width Steps tree instead.
 *   <100 cols:        single-column stack — Tasks (or Steps, without task work items) section.
 *
 * `width={term.columns}` on each row is load-bearing: without it the outer row inherits
 * its intrinsic content width and the Tasks column's `flexGrow={1}` resolves against an
 * un-budgeted parent — leaving a band of unused space on the right at the widest regimes.
 */

import React from 'react';
import { Box } from 'ink';
import { RAIL_WIDTH, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { BaselineHealthCard } from '@src/application/ui/tui/components/baseline-health-card.tsx';
import { TokenBudgetCard } from '@src/application/ui/tui/components/token-budget-card.tsx';
import { Section, SectionHeader } from '@src/application/ui/tui/views/execute-view-internals/section.tsx';
import { FlowStepsRail } from '@src/application/ui/tui/views/execute-view-internals/rail.tsx';
import type { FlowProgress } from '@src/application/ui/tui/runtime/flow-progress.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';

interface LayoutProps {
  readonly progress: FlowProgress | undefined;
  readonly isRunning: boolean;
  readonly sessionId: string;
  readonly termColumns: number;
  readonly flowStepsRows: number;
  readonly threeColRailWidth: number;
  readonly labelledRailWidth: number;
  readonly contextWidth: number;
  readonly threeColumn: boolean;
  readonly twoColumn: boolean;
  readonly compactTwoColumn: boolean;
  readonly tasksPanel: React.ReactNode;
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly now: number;
  readonly tokenUsage: TokenUsage | undefined;
  /** When true the run's pinned sprint is no longer available — baseline-health card is dropped. */
  readonly pinnedSprintStale: boolean;
}

/** Flex Tasks column — identical in every multi-column regime. */
const TasksColumn = ({
  tasksPanel,
  marginRight = 0,
}: {
  readonly tasksPanel: React.ReactNode;
  readonly marginRight?: number;
}): React.JSX.Element => (
  <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} marginRight={marginRight}>
    <SectionHeader title="Tasks" />
    {tasksPanel}
  </Box>
);

/** ≥180 cols — fluid-width rail + flex Tasks + fixed context column. */
const ThreeColumnLayout = ({
  termColumns,
  threeColRailWidth,
  contextWidth,
  flowStepsPanel,
  tasksPanel,
  sessionId,
  executionState,
  taskState,
  now,
  tokenUsage,
  pinnedSprintStale,
}: Pick<
  LayoutProps,
  | 'termColumns'
  | 'threeColRailWidth'
  | 'contextWidth'
  | 'tasksPanel'
  | 'sessionId'
  | 'executionState'
  | 'taskState'
  | 'now'
  | 'tokenUsage'
  | 'pinnedSprintStale'
> & { readonly flowStepsPanel: React.ReactNode }): React.JSX.Element => (
  <Box flexDirection="row" marginTop={spacing.section} width={termColumns}>
    <Box flexDirection="column" width={threeColRailWidth} marginRight={spacing.section} flexShrink={0}>
      <SectionHeader title="Flow steps" />
      {flowStepsPanel}
    </Box>
    <TasksColumn tasksPanel={tasksPanel} marginRight={spacing.section} />
    {/* Right context column — baseline-health card on top (dropped when pinned sprint
        is stale), token-budget card below. */}
    <Box flexDirection="column" width={contextWidth} flexShrink={0}>
      {!pinnedSprintStale && (
        <BaselineHealthCard
          {...(executionState !== undefined ? { execution: executionState } : {})}
          {...(taskState !== undefined ? { tasks: taskState } : {})}
          now={now}
          width={contextWidth}
        />
      )}
      <Box marginTop={spacing.section}>
        <TokenBudgetCard sessionId={sessionId} {...(tokenUsage !== undefined ? { usage: tokenUsage } : {})} />
      </Box>
    </Box>
  </Box>
);

/**
 * 140–179 cols — fixed `RAIL_WIDTH` rail + flex Tasks. The rail keeps the fixed width because
 * there is no context column to compete with the Tasks stream here, so a wider rail would just
 * steal pixels from it.
 */
const TwoColumnLayout = ({
  termColumns,
  flowStepsPanel,
  tasksPanel,
}: Pick<LayoutProps, 'termColumns' | 'tasksPanel'> & {
  readonly flowStepsPanel: React.ReactNode;
}): React.JSX.Element => (
  <Box flexDirection="row" marginTop={spacing.section} width={termColumns}>
    <Box flexDirection="column" width={RAIL_WIDTH} marginRight={spacing.section} flexShrink={0}>
      <SectionHeader title="Flow steps" />
      {flowStepsPanel}
    </Box>
    <TasksColumn tasksPanel={tasksPanel} />
  </Box>
);

/**
 * 100–139 cols — one full-width column: Tasks, or the Steps tree when the flow has no task work
 * items (plan, refine, review, …). The strip in the header already names the main steps.
 */
const CompactLayout = ({
  termColumns,
  main,
  title,
}: Pick<LayoutProps, 'termColumns'> & {
  readonly main: React.ReactNode;
  readonly title: string;
}): React.JSX.Element => (
  <Box flexDirection="row" marginTop={spacing.section} width={termColumns}>
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <SectionHeader title={title} />
      {main}
    </Box>
  </Box>
);

export const ExecuteLayout = ({
  progress,
  isRunning,
  sessionId,
  termColumns,
  flowStepsRows,
  threeColRailWidth,
  labelledRailWidth,
  contextWidth,
  threeColumn,
  twoColumn,
  compactTwoColumn,
  tasksPanel,
  executionState,
  taskState,
  now,
  tokenUsage,
  pinnedSprintStale,
}: LayoutProps): React.JSX.Element => {
  const flowStepsPanel = (
    <FlowStepsRail progress={progress} isRunning={isRunning} maxRows={flowStepsRows} railWidth={labelledRailWidth} />
  );
  // Flows without task work items have nothing for a Tasks panel to show: their steps take its place.
  const stepsInPlaceOfTasks = progress !== undefined && !progress.hasTaskWorkItems;
  const fullWidthSteps = (
    <FlowStepsRail progress={progress} isRunning={isRunning} maxRows={flowStepsRows} railWidth={termColumns - 4} />
  );

  if (threeColumn) {
    return (
      <ThreeColumnLayout
        termColumns={termColumns}
        threeColRailWidth={threeColRailWidth}
        contextWidth={contextWidth}
        flowStepsPanel={flowStepsPanel}
        tasksPanel={tasksPanel}
        sessionId={sessionId}
        executionState={executionState}
        taskState={taskState}
        now={now}
        tokenUsage={tokenUsage}
        pinnedSprintStale={pinnedSprintStale}
      />
    );
  }
  if (twoColumn) {
    return <TwoColumnLayout termColumns={termColumns} flowStepsPanel={flowStepsPanel} tasksPanel={tasksPanel} />;
  }
  if (compactTwoColumn) {
    return (
      <CompactLayout
        termColumns={termColumns}
        title={stepsInPlaceOfTasks ? 'Steps' : 'Tasks'}
        main={stepsInPlaceOfTasks ? fullWidthSteps : tasksPanel}
      />
    );
  }
  // <100 cols — single-column stack.
  return stepsInPlaceOfTasks ? (
    <Section title="Steps">{fullWidthSteps}</Section>
  ) : (
    <Section title="Tasks">{tasksPanel}</Section>
  );
};
