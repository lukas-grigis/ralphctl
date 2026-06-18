/**
 * Body composition for the execute view — the contents of the running-frame `Box` when no
 * help overlay is mounted. Stitches together the multi-flow strip, baseline-health chip,
 * header card, responsive layout, log section, settled-run footer, and the cancel-scope
 * overlay. Pure presentational; the orchestrator does all the data wrangling and just
 * threads the derived values + handlers down.
 */

import React from 'react';
import { Box } from 'ink';
import { BaselineHealthChip } from '@src/application/ui/tui/components/baseline-health-chip.tsx';
import { MultiFlowStrip } from '@src/application/ui/tui/components/multi-flow-strip.tsx';
import { CancelScopeOverlay } from '@src/application/ui/tui/components/cancel-scope-overlay.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import type { SessionDescriptor, SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';

import { HeaderCard } from '@src/application/ui/tui/views/execute-view-internals/header-card.tsx';
import { ExecuteLayout } from '@src/application/ui/tui/views/execute-view-internals/layout.tsx';
import { ImplementLayout } from '@src/application/ui/tui/views/execute-view-internals/implement-layout.tsx';
import { LogPanel } from '@src/application/ui/tui/views/execute-view-internals/log-panel.tsx';
import { Section } from '@src/application/ui/tui/views/execute-view-internals/section.tsx';
import { ResultFooter } from '@src/application/ui/tui/views/execute-view-internals/result-footer.tsx';
import type { ResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { LogEvent } from '@src/business/observability/events.ts';

export interface ExecuteBodyProps {
  readonly descriptor: SessionDescriptor;
  readonly sessionList: readonly SessionRecord[];
  readonly sessionId: string;
  readonly isRunning: boolean;
  readonly now: number;
  readonly elapsed: string;
  /** Numeric wall-clock elapsed (ms) since run start — consumed by the redesigned sidebar layout. */
  readonly elapsedMs: number;
  readonly layout: ResponsiveLayout;
  readonly termColumns: number;
  /** Raw terminal row count — needed by the wide sidebar (ImplementLayout) path. */
  readonly termRows: number;
  /** Bucketed task execution state — feeds the sidebar task-nav list + main area. */
  readonly bucketed: BucketedExecution | undefined;
  /** Sprint label pinned at launch time — shown in the sidebar sprint meta. */
  readonly pinnedSprintLabel: string | undefined;
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
  readonly logEntries: readonly LogEvent[];
  readonly cancelScopeOpen: boolean;
  readonly attemptElapsedMs: number | undefined;
  readonly remainingTaskCount: number;
  readonly onCancelAttempt: () => void;
  readonly onCancelFlow: () => void;
  readonly onDismissCancelScope: () => void;
  /** When true the run's pinned sprint is no longer available — baseline-health surfaces are dropped. */
  readonly pinnedSprintStale: boolean;
}

export const ExecuteBody = ({
  descriptor,
  sessionList,
  sessionId,
  isRunning,
  now,
  elapsed,
  elapsedMs,
  layout,
  termColumns,
  termRows,
  bucketed,
  pinnedSprintLabel,
  executionState,
  taskState,
  tokenUsage,
  tasksDone,
  tasksTotal,
  currentTask,
  currentTaskIdx,
  currentTaskName,
  currentSubStep,
  tasksPanel,
  logEntries,
  cancelScopeOpen,
  attemptElapsedMs,
  remainingTaskCount,
  onCancelAttempt,
  onCancelFlow,
  onDismissCancelScope,
  pinnedSprintStale,
}: ExecuteBodyProps): React.JSX.Element => (
  <Box flexDirection="column">
    {/* Multi-flow chip strip — renders only when ≥2 sessions are running, so a single-
        flow run pays zero pixels. */}
    <MultiFlowStrip sessions={sessionList} activeId={sessionId} now={now} />
    {/* Baseline-health chip + HeaderCard — rendered only for the narrow (<140 col) fallback
        path. The wide sidebarLayout path has a StatusBand inside ImplementLayout that
        consolidates all this meta into one horizontal row, making the chip + card redundant
        (they would waste 5+ rows of vertical space). */}
    {!layout.sidebarLayout && !pinnedSprintStale && (
      <Box paddingX={spacing.indent}>
        <BaselineHealthChip
          {...(executionState !== undefined ? { execution: executionState } : {})}
          {...(taskState !== undefined ? { tasks: taskState } : {})}
          now={now}
        />
      </Box>
    )}
    {!layout.sidebarLayout && (
      <HeaderCard
        descriptor={descriptor}
        isRunning={isRunning}
        elapsed={elapsed}
        tasksDone={tasksDone}
        tasksTotal={tasksTotal}
        currentTask={currentTask}
        currentTaskIdx={currentTaskIdx}
        currentTaskName={currentTaskName}
        currentSubStep={currentSubStep}
      />
    )}

    {layout.sidebarLayout ? (
      <ImplementLayout
        layout={layout}
        bucketed={bucketed}
        elapsed={elapsedMs}
        pinnedSprintLabel={pinnedSprintLabel}
        termRows={termRows}
        inputActive={!cancelScopeOpen}
        descriptor={descriptor}
        isRunning={isRunning}
        sessionId={sessionId}
        termColumns={termColumns}
        tasksPanel={tasksPanel}
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
    )}

    <Section title="Recent log">
      <LogPanel entries={logEntries} maxRows={layout.logRows} />
    </Section>

    <ResultFooter
      descriptor={descriptor}
      isRunning={isRunning}
      tasksDone={tasksDone}
      tasksTotal={tasksTotal}
      elapsed={elapsed}
    />

    {/* Cancel-scope picker — mounted only while running AND the operator pressed `c`.
        While mounted it claims keyboard input via its own useInput hook; the surrounding
        view's `c` handler is gated behind `cancelScopeOpen` so the keystroke isn't
        consumed twice. */}
    {isRunning && cancelScopeOpen && (
      <CancelScopeOverlay
        attemptElapsedMs={attemptElapsedMs}
        remainingTaskCount={remainingTaskCount}
        onCancelAttempt={onCancelAttempt}
        onCancelFlow={onCancelFlow}
        onDismiss={onDismissCancelScope}
      />
    )}
  </Box>
);
