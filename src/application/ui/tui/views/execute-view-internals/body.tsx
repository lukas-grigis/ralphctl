/**
 * Body composition for the execute view — the contents of the running-frame `Box` when no help overlay is mounted.
 */

import React, { useMemo } from 'react';
import { Box } from 'ink';
import { MultiFlowStrip } from '@src/application/ui/tui/components/multi-flow-strip.tsx';
import { CancelScopeOverlay } from '@src/application/ui/tui/components/cancel-scope-overlay.tsx';
import type { SessionDescriptor, SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { overlayEntityBlockedStatus } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';

import { HeaderCard } from '@src/application/ui/tui/views/execute-view-internals/header-card.tsx';
import { ExecuteLayout } from '@src/application/ui/tui/views/execute-view-internals/layout.tsx';
import { ImplementLayout } from '@src/application/ui/tui/views/execute-view-internals/implement-layout.tsx';
import { LogPanel } from '@src/application/ui/tui/views/execute-view-internals/log-panel.tsx';
import { ResultFooter } from '@src/application/ui/tui/views/execute-view-internals/result-footer.tsx';
import type { ResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import type { NextSteps } from '@src/application/ui/shared/next-steps.ts';

export interface ExecuteBodyProps {
  readonly descriptor: SessionDescriptor;
  readonly sessionList: readonly SessionRecord[];
  readonly sessionId: string;
  readonly isRunning: boolean;
  readonly now: number;
  readonly elapsed: string;
  readonly layout: ResponsiveLayout;
  readonly termColumns: number;
  /** Bucketed task execution state — feeds the sidebar task-nav list + main area. */
  readonly bucketed: BucketedExecution | undefined;
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly tokenUsage: TokenUsage | undefined;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly currentTask: TaskBucket | undefined;
  readonly currentTaskIdx: number;
  readonly currentTaskName: string | undefined;
  readonly currentSubStep: string | undefined;
  readonly tasksPanel: React.ReactNode;
  /** `v` handler for the task cards. */
  readonly onOpenEvaluation: (taskId: string) => void;
  readonly logEntries: readonly LogEvent[];
  readonly cancelScopeOpen: boolean;
  /** False while an overlay, prompt or cancel picker is open — gates the wide Tasks panel's keys. */
  readonly tasksInputActive: boolean;
  readonly attemptElapsedMs: number | undefined;
  readonly remainingTaskCount: number;
  readonly onCancelAttempt: () => void;
  readonly onCancelFlow: () => void;
  readonly onDismissCancelScope: () => void;
  /** When true the run's pinned sprint is no longer available — baseline-health surfaces are dropped. */
  readonly pinnedSprintStale: boolean;
  /** Settled-run "what next" + post-mortem paths, forwarded verbatim to the {@link ResultFooter}. */
  readonly nextSteps: NextSteps;
  /** Runs blocked on a prompt → waiting since (epoch ms). */
  readonly awaiting?: ReadonlyMap<string, number>;
}

/** The rail / tasks / context region between the header card and the log panel. */
const MainRegion = ({
  layout,
  descriptor,
  isRunning,
  sessionId,
  termColumns,
  bucketed,
  tasksInputActive,
  tasksPanel,
  onOpenEvaluation,
  executionState,
  taskState,
  now,
  tokenUsage,
  pinnedSprintStale,
}: Pick<
  ExecuteBodyProps,
  | 'layout'
  | 'descriptor'
  | 'isRunning'
  | 'sessionId'
  | 'termColumns'
  | 'bucketed'
  | 'tasksInputActive'
  | 'tasksPanel'
  | 'onOpenEvaluation'
  | 'executionState'
  | 'taskState'
  | 'now'
  | 'tokenUsage'
  | 'pinnedSprintStale'
>): React.JSX.Element =>
  layout.sidebarLayout ? (
    <ImplementLayout
      layout={layout}
      bucketed={bucketed}
      inputActive={tasksInputActive}
      descriptor={descriptor}
      isRunning={isRunning}
      termColumns={termColumns}
      tasksPanel={tasksPanel}
      onOpenEvaluation={onOpenEvaluation}
      executionState={executionState}
      taskState={taskState}
      now={now}
      tokenUsage={tokenUsage}
      pinnedSprintStale={pinnedSprintStale}
    />
  ) : (
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

/** Cancel-scope picker — mounted only while running AND the operator pressed `c`. */
const CancelScopePicker = ({
  isRunning,
  cancelScopeOpen,
  attemptElapsedMs,
  remainingTaskCount,
  onCancelAttempt,
  onCancelFlow,
  onDismissCancelScope,
}: Pick<
  ExecuteBodyProps,
  | 'isRunning'
  | 'cancelScopeOpen'
  | 'attemptElapsedMs'
  | 'remainingTaskCount'
  | 'onCancelAttempt'
  | 'onCancelFlow'
  | 'onDismissCancelScope'
>): React.JSX.Element | null => {
  if (!isRunning || !cancelScopeOpen) return null;
  return (
    <CancelScopeOverlay
      attemptElapsedMs={attemptElapsedMs}
      remainingTaskCount={remainingTaskCount}
      onCancelAttempt={onCancelAttempt}
      onCancelFlow={onCancelFlow}
      onDismiss={onDismissCancelScope}
    />
  );
};

/**
 * `MainRegion` and `CancelScopePicker` each declare the exact slice of {@link ExecuteBodyProps} they consume, so the
 * whole bag is spread into them rather than re-listing two dozen names here.
 */
export const ExecuteBody = (props: ExecuteBodyProps): React.JSX.Element => {
  const {
    descriptor,
    sessionList,
    sessionId,
    isRunning,
    now,
    elapsed,
    layout,
    tasksDone,
    tasksTotal,
    bucketed,
    taskState,
    currentTask,
    currentTaskIdx,
    currentTaskName,
    currentSubStep,
    logEntries,
    nextSteps,
    awaiting,
  } = props;
  // `tasksDone` is trace-derived (`use-bucketed-tasks.ts`'s `summariseProgress`) and can undercount a task's
  // own-failure block as a pass.
  const effectiveTasksDone = useMemo(
    () =>
      bucketed !== undefined
        ? overlayEntityBlockedStatus(bucketed, taskState, isRunning).tasks.filter((t) => t.status === 'completed')
            .length
        : tasksDone,
    [bucketed, taskState, tasksDone, isRunning]
  );
  return (
    <Box flexDirection="column">
      {/* Multi-flow chip strip — renders only when ≥2 sessions are running, so a single-
        flow run pays zero pixels. */}
      <MultiFlowStrip sessions={sessionList} activeId={sessionId} now={now} {...(awaiting ? { awaiting } : {})} />
      {/* HeaderCard — rendered at all widths. At ≥140 cols the BaselineHealthCard lives in the
        sidebar; at <140 cols it appears in the narrow layout via ExecuteLayout. */}
      <HeaderCard
        descriptor={descriptor}
        isRunning={isRunning}
        tasksDone={effectiveTasksDone}
        tasksTotal={tasksTotal}
        currentTask={currentTask}
        currentTaskIdx={currentTaskIdx}
        currentTaskName={currentTaskName}
        currentSubStep={currentSubStep}
        waitingSince={awaiting?.get(sessionId)}
      />

      {/* Verdict first: a settled run's outcome + next steps sit under the header, so they stay
        on screen at any height instead of below the tasks and log. */}
      <ResultFooter
        descriptor={descriptor}
        isRunning={isRunning}
        tasksDone={effectiveTasksDone}
        tasksTotal={tasksTotal}
        elapsed={elapsed}
        nextSteps={nextSteps}
      />

      <MainRegion {...props} />

      <LogPanel entries={logEntries} maxRows={layout.logRows} />

      <CancelScopePicker {...props} />
    </Box>
  );
};
