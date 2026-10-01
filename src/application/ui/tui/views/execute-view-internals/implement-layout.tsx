/** ImplementLayout — layout compositor for the redesigned Implement view. */

import React, { useCallback, useState } from 'react';
import { Box } from 'ink';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { ExecuteLayout } from '@src/application/ui/tui/views/execute-view-internals/layout.tsx';
import { ImplementSidebar } from '@src/application/ui/tui/views/execute-view-internals/implement-sidebar.tsx';
import { ImplementMainArea } from '@src/application/ui/tui/views/execute-view-internals/implement-main-area.tsx';
import type { ResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';

export interface ImplementLayoutProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly sessionId: string;
  readonly termColumns: number;
  readonly termRows: number;
  /** Pre-built TasksPanel node used by the narrow (<140 col) ExecuteLayout fallback only. */
  readonly tasksPanel: React.ReactNode;
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly now: number;
  readonly tokenUsage: TokenUsage | undefined;
  readonly pinnedSprintStale: boolean;

  /** Full responsive-layout record — drives the sidebarLayout switch + sidebar sizing. */
  readonly layout: ResponsiveLayout;
  /** Bucketed task execution state — drives the sidebar task-nav list + ImplementMainArea. */
  readonly bucketed: BucketedExecution | undefined;
  /**
   * When true, keyboard input is active for this compositor and its children. Gating prevents double-consumption when
   * a cancel-scope overlay or other overlay is open.
   */
  readonly inputActive: boolean;
  /** Optional `v` handler — opens the evaluation overlay for a card with a recorded verdict. */
  readonly onOpenEvaluation?: (taskId: string) => void;
}

// Wide compositor (sidebarLayout === true, ≥140 cols)

interface WideLayoutProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly termColumns: number;
  readonly layout: ResponsiveLayout;
  readonly bucketed: BucketedExecution | undefined;
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly now: number;
  readonly tokenUsage?: TokenUsage;
  readonly inputActive: boolean;
  readonly onOpenEvaluation?: (taskId: string) => void;
}

const WideLayout = ({
  descriptor,
  isRunning,
  termColumns,
  layout,
  bucketed,
  executionState,
  taskState,
  now,
  tokenUsage,
  inputActive,
  onOpenEvaluation,
}: WideLayoutProps): React.JSX.Element => {
  // focusedTaskId is the id reported by the main-area panel on every card-cursor change.
  // The sidebar renders this as a passive highlight — no sidebar input capture.
  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(undefined);
  const onFocusedCardChange = useCallback((taskId: string | undefined) => {
    setFocusedTaskId(taskId);
  }, []);

  return (
    <Box flexDirection="column" width={termColumns}>
      {/* ── Column strip (no column labels — sections are self-labelled) ─── */}
      <Box flexDirection="row" marginTop={spacing.section}>
        {/* ── Left: sidebar (baseline card + steps + task-nav + token budget) */}
        <Box flexDirection="column" width={layout.sidebarWidth} flexShrink={0}>
          <ImplementSidebar
            sidebarWidth={layout.sidebarWidth}
            sidebarTaskNavRows={layout.sidebarTaskNavRows}
            sidebarFlowStepsRows={layout.sidebarFlowStepsRows}
            sidebarContextSideBySide={layout.sidebarContextSideBySide}
            descriptor={descriptor}
            bucketed={bucketed}
            isRunning={isRunning}
            focusedTaskId={focusedTaskId}
            now={now}
            {...(executionState !== undefined ? { executionState } : {})}
            {...(taskState !== undefined ? { taskState } : {})}
            {...(tokenUsage !== undefined ? { tokenUsage } : {})}
          />
        </Box>

        {/* ── Right: main area (sole input owner) ───────────────────────── */}
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
          <ImplementMainArea
            bucketed={bucketed}
            descriptor={descriptor}
            isRunning={isRunning}
            maxSignalsPerTask={layout.tasksMaxSignals}
            maxTasks={layout.tasksMaxBlocks}
            inputActive={inputActive}
            now={now}
            taskState={taskState}
            onFocusedCardChange={onFocusedCardChange}
            {...(onOpenEvaluation !== undefined ? { onOpenEvaluation } : {})}
          />
        </Box>
      </Box>
    </Box>
  );
};

/**
 * Compositor that selects the correct layout regime for the Implement view. At ≥140 cols (`layout.sidebarLayout ===
 * true`) it renders [sidebar | main-area].
 * @public — wired by `body.tsx`.
 */
export const ImplementLayout = ({
  descriptor,
  isRunning,
  sessionId,
  termColumns,
  // termRows is accepted for interface parity with body.tsx but is not consumed here — the
  // sidebar height is managed via layout.sidebarTaskNavRows / layout.sidebarFlowStepsRows.
  tasksPanel,
  executionState,
  taskState,
  now,
  tokenUsage,
  pinnedSprintStale,
  layout,
  bucketed,
  inputActive,
  onOpenEvaluation,
}: ImplementLayoutProps): React.JSX.Element => {
  if (layout.sidebarLayout) {
    return (
      <WideLayout
        descriptor={descriptor}
        isRunning={isRunning}
        termColumns={termColumns}
        layout={layout}
        bucketed={bucketed}
        executionState={executionState}
        taskState={taskState}
        now={now}
        inputActive={inputActive}
        {...(tokenUsage !== undefined ? { tokenUsage } : {})}
        {...(onOpenEvaluation !== undefined ? { onOpenEvaluation } : {})}
      />
    );
  }

  // Narrow fallback — preserve existing behaviour exactly.
  return (
    <ExecuteLayout
      descriptor={descriptor}
      isRunning={isRunning}
      sessionId={sessionId}
      termColumns={termColumns}
      flowStepsRows={layout.flowStepsRows}
      threeColRailWidth={layout.threeColRailWidth}
      labelledRailWidth={layout.labelledRailWidth}
      contextWidth={layout.contextWidth}
      threeColumn={layout.threeColumn}
      twoColumn={layout.twoColumn}
      compactTwoColumn={layout.compactTwoColumn}
      tasksPanel={tasksPanel}
      executionState={executionState}
      taskState={taskState}
      now={now}
      tokenUsage={tokenUsage}
      pinnedSprintStale={pinnedSprintStale}
    />
  );
};
