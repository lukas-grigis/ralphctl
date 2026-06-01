/**
 * Implement view — live dashboard for an Implement chain run.
 *
 * The orchestrator wires data hooks to presentational sibling pieces under
 * `execute-view-internals/`:
 *   - `body.tsx`                — composes header / layout / log / footer / overlay
 *   - `header-card.tsx`         — flow / elapsed / tasks / model / active-task header
 *   - `rail.tsx`                — labelled + compact flow-steps StepTrace variants
 *   - `layout.tsx`              — responsive column switcher (3 / 2 / compact-2 / 1)
 *   - `log-panel.tsx`           — bottom Recent-log panel + buffer-cap rationale
 *   - `tasks-panel-host.tsx`    — TasksPanel adapter folding verificationCriteria mapping
 *   - `result-footer.tsx`       — settled ResultCard / running spinner
 *   - `section.tsx`             — shared SectionHeader / Section helpers
 *   - `use-baseline-health-data.ts`  — 3 s polling of SprintExecution + Task list
 *   - `use-bucketed-tasks.ts`        — bucketTaskSignals + monotonic round overlay
 *   - `use-active-task-summary.ts`   — yank-provider registration effect
 *   - `use-cancel-handlers.ts`       — cancel-attempt / cancel-flow handlers
 *   - `use-cancel-scope-stats.ts`    — attempt-elapsed + remaining-task stats
 *   - `use-execute-input.ts`         — keyboard + view-hint registration
 *   - `use-live-clock.ts`            — 1-Hz tick while running
 *   - `use-responsive-layout.ts`     — width-regime + row-cap derivation
 *
 * Layout regimes (driven by terminal width):
 *  - ≥180 cols (xl+): three-column — fluid-width rail, flex Tasks, fixed context column.
 *  - 140–179 cols   : two-column — fixed RAIL_WIDTH rail + flex Tasks. No context column.
 *  - 100–139 cols   : compact two-column — glyph-only rail + flex Tasks.
 *  - <100 cols      : single-column stack.
 *
 * Local keys:
 *   c — open the cancel-scope picker (1 = cancel attempt, 2 = cancel whole flow)
 *   D — detach (return to home; the runner keeps running in the background)
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { runnerStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useTokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useSession, useSessionManager, useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useBuses } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { useSinkStream } from '@src/application/ui/tui/runtime/use-sink-stream.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useEventBusBuffer } from '@src/application/ui/tui/runtime/use-event-bus.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { useUiState, type FocusedRunCtx } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';

import { ExecuteBody } from '@src/application/ui/tui/views/execute-view-internals/body.tsx';
import { LOG_TAIL_LIMIT } from '@src/application/ui/tui/views/execute-view-internals/log-panel.tsx';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import { useActiveTaskSummary } from '@src/application/ui/tui/views/execute-view-internals/use-active-task-summary.ts';
import { useBaselineHealthData } from '@src/application/ui/tui/views/execute-view-internals/use-baseline-health-data.ts';
import { useBucketedTasks } from '@src/application/ui/tui/views/execute-view-internals/use-bucketed-tasks.ts';
import { useCancelHandlers } from '@src/application/ui/tui/views/execute-view-internals/use-cancel-handlers.ts';
import { useCancelScopeStats } from '@src/application/ui/tui/views/execute-view-internals/use-cancel-scope-stats.ts';
import { useResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import { useExecuteInput } from '@src/application/ui/tui/views/execute-view-internals/use-execute-input.ts';
import { useLiveClock } from '@src/application/ui/tui/views/execute-view-internals/use-live-clock.ts';

interface ExecuteProps extends Readonly<Record<string, unknown>> {
  readonly sessionId: string;
}

/**
 * Buffer sizing for long Implement runs:
 *   - harness signals: ~20-40 per task (changes, learnings, decisions, commit messages, …),
 *     so 10 tasks × 30 = 300; 1000 keeps healthy headroom for a multi-hour 20-task sprint.
 *   - chainEvents: drives per-task time windows in bucketTaskSignals. We need the EARLIEST
 *     events for early tasks to keep their signal correlation intact. 2000 covers ~15 tasks
 *     × ~12 substeps × ~5 gen-eval rounds + outer-flow leaves.
 * When a buffer overflows it drops the OLDEST entry. The on-disk chain.log is authoritative.
 */
const HARNESS_SIGNAL_LIMIT = 1000;
const CHAIN_EVENT_LIMIT = 2000;

export const ExecuteView = (): React.JSX.Element => {
  const { sessionId } = useViewProps<ExecuteProps>();
  const session = useSession(sessionId);
  const sessions = useSessionManager();
  // Live list of every session for the multi-flow strip (renders only when ≥2 are running).
  const sessionList = useSessions();
  const router = useRouter();
  const ui = useUiState();
  const buses = useBuses();
  const signals = useSinkStream(buses.harness, { limit: HARNESS_SIGNAL_LIMIT });
  const logEntries = useSinkStream(buses.log, { limit: LOG_TAIL_LIMIT });
  const deps = useDeps();
  const eventBus = deps.eventBus;
  const chainEvents = useEventBusBuffer<AppEvent>(eventBus, {
    filter: (e): e is AppEvent => 'chainId' in e && (e as { chainId: string }).chainId === sessionId,
    limit: CHAIN_EVENT_LIMIT,
  });
  const term = useTerminalSize();

  // Each Execute view is scoped to its session's pinned sprint so concurrent runs remain
  // independent of each other and of the mutable global selection.
  const pinnedSprintId = session?.descriptor?.pinnedSprintId as SprintId | undefined;
  const pinnedProjectLabel = session?.descriptor?.pinnedProjectLabel;
  const pinnedSprintLabel = session?.descriptor?.pinnedSprintLabel;

  // Best-effort probe: mark the sprint unavailable when it has been closed or removed so
  // the Execute view can show an inline fallback instead of stale panel data.
  const [pinnedSprintAvailable, setPinnedSprintAvailable] = React.useState(true);
  React.useEffect(() => {
    if (pinnedSprintId === undefined) return undefined;
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const r = await deps.sprintRepo.findById(pinnedSprintId);
        if (cancelled) return;
        if (!r.ok || r.value.status === 'done') setPinnedSprintAvailable(false);
      } catch {
        // Keep available on error (absent repo in test harnesses, transient I/O failures).
      }
    };
    void check();
    return (): void => {
      cancelled = true;
    };
  }, [pinnedSprintId, deps.sprintRepo]);

  // Register this run's pinned project/sprint as the focused-run context so breadcrumb and
  // progress overlay reflect the run's own sprint while this view is mounted.
  const setFocusedRunContext = ui.setFocusedRunContext;
  React.useEffect(() => {
    const ctx: FocusedRunCtx = {
      projectLabel: pinnedProjectLabel,
      sprintId: pinnedSprintId,
      sprintLabel: pinnedSprintLabel,
    };
    setFocusedRunContext(ctx);
    return (): void => {
      setFocusedRunContext(undefined);
    };
  }, [pinnedProjectLabel, pinnedSprintId, pinnedSprintLabel, setFocusedRunContext]);

  const baselineSprintId: SprintId | undefined = pinnedSprintId;
  const { executionState, taskState } = useBaselineHealthData({
    baselineSprintId,
    sprintExecutionRepo: deps.sprintExecutionRepo,
    taskRepo: deps.taskRepo,
  });

  const isRunning = session?.descriptor.status === 'running';

  // Cancel-scope picker — `c` no longer aborts immediately; it opens an inline overlay that
  // distinguishes "cancel current attempt" (keep task queued, retry next round) from "cancel
  // whole flow" (mark current task blocked + exit chain). The overlay claims the keyboard
  // while mounted so the picker's `1` / `2` / `esc` keystrokes don't fight this handler.
  const [cancelScopeOpen, setCancelScopeOpen] = React.useState(false);

  useExecuteInput({
    isRunning,
    cancelScopeOpen,
    setCancelScopeOpen,
    helpOpen: ui.helpOpen,
    promptActive: ui.promptActive,
    router,
    sprintId: pinnedSprintId,
  });

  const now = useLiveClock(isRunning);

  const { bucketed, tasksDone, tasksTotal, currentTask, currentTaskIdx, currentTaskName, currentSubStep } =
    useBucketedTasks({ descriptor: session?.descriptor, chainEvents, signals, eventBus });

  // Per-session token usage — latest `TokenUsageEvent` per sessionId. The execute view is
  // sessionId-scoped so we only look up the current runner's entry; absent ⇒ empty state.
  const tokenUsageBySession = useTokenUsage(eventBus);
  const tokenUsage = tokenUsageBySession.get(sessionId);

  // Stash the stable setter so the active-task-summary effect doesn't fire on unrelated
  // UI state toggles (helpOpen, claims, …).
  const setActiveTaskSummaryProvider = ui.setActiveTaskSummaryProvider;
  useActiveTaskSummary({ currentTask, currentTaskName, setActiveTaskSummaryProvider });

  const { attemptElapsedMs, remainingTaskCount } = useCancelScopeStats({
    chainEvents,
    currentTask,
    bucketed,
    now,
  });

  const {
    onCancelAttempt,
    onCancelFlow,
    onDismiss: onDismissCancelScope,
  } = useCancelHandlers({
    sessions,
    sessionId,
    sprintId: pinnedSprintId,
    currentTask,
    taskRepo: deps.taskRepo,
    logger: deps.logger,
    setCancelScopeOpen,
  });

  const layout = useResponsiveLayout({ columns: term.columns, rows: term.rows, isRunning });

  // Early-return for "no session in registry" must come AFTER every hook above so the Hook
  // call order is identical across renders. Hooks below this line do not exist — every Hook
  // the view needs has already run.
  const descriptor = session?.descriptor;
  if (!session || descriptor === undefined) {
    return (
      <ViewShell title="Implement" subtitle="(unknown session)">
        <Box paddingX={spacing.indent}>
          <Text dimColor>The session id was not found in the registry. It may have been removed.</Text>
        </Box>
      </ViewShell>
    );
  }

  const elapsed = fmtElapsed(descriptor.startedAt, descriptor.finishedAt ?? now);

  // TasksPanel claims input for the signal-row cursor (j/k or ↑/↓ to move, Enter / Space to
  // expand a commit-message row). Disabled while any modal owns the keyboard so the cursor
  // can't fight the help overlay (`?`), the progress overlay (`g`), or a prompt.
  const tasksInputActive = !ui.helpOpen && !ui.progressOpen && !ui.promptActive;

  // When the pinned sprint is no longer available (done or removed), blank the panels that
  // depend on it and surface a pick-a-sprint prompt so the user knows what happened.
  const pinnedSprintStale = pinnedSprintId !== undefined && !pinnedSprintAvailable;

  const tasksPanel = pinnedSprintStale ? (
    <Box paddingX={spacing.indent}>
      <Text dimColor>Sprint no longer available — pick a sprint to continue.</Text>
    </Box>
  ) : (
    <TasksPanelHost
      bucketed={bucketed}
      descriptor={descriptor}
      isRunning={isRunning}
      maxSignalsPerTask={layout.tasksMaxSignals}
      inputActive={tasksInputActive}
      now={now}
      taskState={taskState}
    />
  );

  const effectiveExecutionState = pinnedSprintStale ? undefined : executionState;
  const effectiveTaskState = pinnedSprintStale ? undefined : taskState;

  return (
    <ViewShell
      title="Implement"
      subtitle={descriptor.title}
      compactBanner
      right={<StatusChip label={descriptor.status} kind={runnerStatusKind(descriptor.status)} />}
    >
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : (
        <ExecuteBody
          descriptor={descriptor}
          sessionList={sessionList}
          sessionId={sessionId}
          isRunning={isRunning}
          now={now}
          elapsed={elapsed}
          layout={layout}
          termColumns={term.columns}
          executionState={effectiveExecutionState}
          taskState={effectiveTaskState}
          tokenUsage={tokenUsage}
          tasksDone={tasksDone}
          tasksTotal={tasksTotal}
          currentTask={currentTask}
          currentTaskIdx={currentTaskIdx}
          currentTaskName={currentTaskName}
          currentSubStep={currentSubStep}
          tasksPanel={tasksPanel}
          logEntries={logEntries}
          cancelScopeOpen={cancelScopeOpen}
          attemptElapsedMs={attemptElapsedMs}
          remainingTaskCount={remainingTaskCount}
          onCancelAttempt={onCancelAttempt}
          onCancelFlow={onCancelFlow}
          onDismissCancelScope={onDismissCancelScope}
          pinnedSprintStale={pinnedSprintStale}
        />
      )}
    </ViewShell>
  );
};
