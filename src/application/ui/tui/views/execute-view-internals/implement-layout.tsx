/**
 * ImplementLayout — the ≥140-col Execute composition: [ImplementSidebar | main area]. Narrower
 * terminals use `ExecuteLayout`; body.tsx picks between them.
 *
 * HeaderCard is rendered by `body.tsx` above this row. A flow without task work items (plan,
 * refine, review, …) swaps the Tasks main area for a full-height Steps tree and drops the
 * sidebar Steps section.
 *
 * Passive-minimap keyboard model: `TasksPanelHost` is the single input owner and reports its
 * focused card via `onFocusedCardChange`; the sidebar only highlights that row (no sidebar
 * focus, no Tab toggle, one cursor).
 */

import React, { useState } from 'react';
import { Box } from 'ink';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { ImplementSidebar } from '@src/application/ui/tui/views/execute-view-internals/implement-sidebar.tsx';
import { FlowStepsRail } from '@src/application/ui/tui/views/execute-view-internals/rail.tsx';
import { SectionHeader } from '@src/application/ui/tui/views/execute-view-internals/section.tsx';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import type { ResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/responsive-layout.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { FlowProgress } from '@src/application/ui/tui/runtime/flow-progress.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';

export interface ImplementLayoutProps {
  readonly descriptor: SessionDescriptor;
  /** Flow-progress projection — undefined for a session without a plan tree. */
  readonly progress?: FlowProgress | undefined;
  readonly isRunning: boolean;
  readonly termColumns: number;
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly now: number;
  readonly tokenUsage: TokenUsage | undefined;
  readonly layout: ResponsiveLayout;
  readonly bucketed: BucketedExecution | undefined;
  /** False while an overlay or cancel picker is open — stops the Tasks panel consuming keys. */
  readonly inputActive: boolean;
  /** `v` handler: opens the evaluation overlay for a card with a recorded verdict. */
  readonly onOpenEvaluation?: (taskId: string) => void;
}

export const ImplementLayout = ({
  descriptor,
  progress,
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
}: ImplementLayoutProps): React.JSX.Element => {
  const [focusedTaskId, setFocusedTaskId] = useState<string | undefined>(undefined);

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
            progress={progress}
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
          {progress !== undefined && !progress.hasTaskWorkItems ? (
            <>
              <SectionHeader title="Steps" />
              <FlowStepsRail
                progress={progress}
                isRunning={isRunning}
                maxRows={layout.stepsMainRows}
                railWidth={termColumns - layout.sidebarWidth - 2}
              />
            </>
          ) : (
            <TasksPanelHost
              bucketed={bucketed}
              descriptor={descriptor}
              progress={progress}
              isRunning={isRunning}
              maxSignalsPerTask={layout.tasksMaxSignals}
              maxTasks={layout.tasksMaxBlocks}
              maxSubStepsPerTask={layout.taskStepTreeRows}
              inputActive={inputActive}
              now={now}
              taskState={taskState}
              onFocusedCardChange={setFocusedTaskId}
              {...(onOpenEvaluation !== undefined ? { onOpenEvaluation } : {})}
            />
          )}
        </Box>
      </Box>
    </Box>
  );
};
