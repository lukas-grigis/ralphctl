/**
 * Responsive layout switcher for the execute view's main body — rail / tasks / context
 * column composition that adapts to the terminal width. Four regimes:
 *
 *   ≥180 cols (xl+):  three-column — fluid-width rail (resolveRailWidth) + flex Tasks + fixed
 *                     context column (BaselineHealthCard + TokenBudgetCard).
 *   140–179 cols:     two-column — fixed RAIL_WIDTH rail + flex Tasks. No context column.
 *   100–139 cols:     compact two-column — glyph-only rail + flex Tasks. "Flow steps"
 *                     header is dropped because it would overflow the narrow rail.
 *   <100 cols:        single-column stack — labelled rail + Tasks rendered as sections.
 *
 * `width={term.columns}` on each row is load-bearing: without it the outer row inherits
 * its intrinsic content width and the Tasks column's `flexGrow={1}` resolves against an
 * un-budgeted parent — leaving a band of unused space on the right at the widest regimes.
 */

import React from 'react';
import { Box } from 'ink';
import { COMPACT_RAIL_WIDTH, RAIL_WIDTH, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { BaselineHealthCard } from '@src/application/ui/tui/components/baseline-health-card.tsx';
import { TokenBudgetCard } from '@src/application/ui/tui/components/token-budget-card.tsx';
import { Section, SectionHeader } from '@src/application/ui/tui/views/execute-view-internals/section.tsx';
import { CompactFlowStepsRail, FlowStepsRail } from '@src/application/ui/tui/views/execute-view-internals/rail.tsx';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';

interface LayoutProps {
  readonly descriptor: SessionDescriptor;
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

export const ExecuteLayout = ({
  descriptor,
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
    <FlowStepsRail
      descriptor={descriptor}
      isRunning={isRunning}
      maxRows={flowStepsRows}
      railWidth={labelledRailWidth}
    />
  );
  const compactFlowStepsPanel = (
    <CompactFlowStepsRail descriptor={descriptor} isRunning={isRunning} maxRows={flowStepsRows} />
  );

  if (threeColumn) {
    return (
      <Box flexDirection="row" marginTop={spacing.section} width={termColumns}>
        <Box flexDirection="column" width={threeColRailWidth} marginRight={spacing.section} flexShrink={0}>
          <SectionHeader title="Flow steps" />
          {flowStepsPanel}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} marginRight={spacing.section}>
          <SectionHeader title="Tasks" />
          {tasksPanel}
        </Box>
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
  }

  if (twoColumn) {
    // Rail keeps the fixed `RAIL_WIDTH` (28) — at 140-179 cols there's no context column
    // to compete with the Tasks stream, so a wider rail would just steal pixels from it.
    return (
      <Box flexDirection="row" marginTop={spacing.section} width={termColumns}>
        <Box flexDirection="column" width={RAIL_WIDTH} marginRight={spacing.section} flexShrink={0}>
          <SectionHeader title="Flow steps" />
          {flowStepsPanel}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
          <SectionHeader title="Tasks" />
          {tasksPanel}
        </Box>
      </Box>
    );
  }

  if (compactTwoColumn) {
    // The rail's SectionHeader is dropped because "Flow steps" overflows the narrow column;
    // the glyph-only column reads as a status spine.
    return (
      <Box flexDirection="row" marginTop={spacing.section} width={termColumns}>
        <Box flexDirection="column" width={COMPACT_RAIL_WIDTH} marginRight={spacing.section} flexShrink={0}>
          {compactFlowStepsPanel}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
          <SectionHeader title="Tasks" />
          {tasksPanel}
        </Box>
      </Box>
    );
  }

  return (
    <>
      <Section title="Flow steps">{flowStepsPanel}</Section>
      <Section title="Tasks">{tasksPanel}</Section>
    </>
  );
};
