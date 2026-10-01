/** Implement view — live dashboard for an Implement chain run. */

import React from 'react';
import { Box, Text } from 'ink';
import { useAwaitingSessions } from '@src/application/ui/tui/runtime/use-awaiting-sessions.ts';
import { flowIdToTitle } from '@src/application/ui/shared/flow-title.ts';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { runnerStatusKind, StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useTokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useSession, useSessionManager, useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { type SignalBusEntry, useBuses } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { useSinkStream } from '@src/application/ui/tui/runtime/use-sink-stream.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useEventBusBuffer } from '@src/application/ui/tui/runtime/use-event-bus.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type {
  SessionDescriptor,
  SessionManager,
  SessionRecord,
} from '@src/application/ui/tui/runtime/session-manager.ts';
import type { RouterApi } from '@src/application/ui/tui/runtime/router.tsx';
import type { TerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import type { LogEvent } from '@src/business/observability/events.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { ResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import type { BucketedDerivation } from '@src/application/ui/tui/views/execute-view-internals/use-bucketed-tasks.ts';
import type { CancelHandlers } from '@src/application/ui/tui/views/execute-view-internals/use-cancel-handlers.ts';
import type { NextSteps } from '@src/application/ui/shared/next-steps.ts';
import { useRunSprintContext } from '@src/application/ui/tui/views/execute-view-internals/use-run-sprint-context.ts';

import { ExecuteBody } from '@src/application/ui/tui/views/execute-view-internals/body.tsx';
import { LOG_TAIL_LIMIT } from '@src/application/ui/tui/views/execute-view-internals/log-panel.tsx';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import { useActiveTaskSummary } from '@src/application/ui/tui/views/execute-view-internals/use-active-task-summary.ts';
import { useBucketedTasks } from '@src/application/ui/tui/views/execute-view-internals/use-bucketed-tasks.ts';
import { useCancelHandlers } from '@src/application/ui/tui/views/execute-view-internals/use-cancel-handlers.ts';
import { useCancelScopeStats } from '@src/application/ui/tui/views/execute-view-internals/use-cancel-scope-stats.ts';
import { useResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import { useExecuteInput } from '@src/application/ui/tui/views/execute-view-internals/use-execute-input.ts';
import { useLiveClock } from '@src/application/ui/tui/views/execute-view-internals/use-live-clock.ts';
import { useEvaluationChord } from '@src/application/ui/tui/views/execute-view-internals/use-open-evaluation.ts';

interface ExecuteProps extends Readonly<Record<string, unknown>> {
  readonly sessionId: string;
}

/**
 * Launchers title a session `<Flow> — <sprint or project name>`; the shell already prints the flow as its title, so
 * the subtitle keeps only the name (otherwise it reads `Implement — Implement — …`).
 */
const sprintNameOf = (sessionTitle: string): string => {
  const sep = ' — ';
  const at = sessionTitle.indexOf(sep);
  return at === -1 ? sessionTitle : sessionTitle.slice(at + sep.length);
};

/**
 * Buffer sizing for long Implement runs: ~30 harness signals per task, so 1000 leaves headroom for a 20-task sprint;
 * 2000 chain events keep early tasks' time windows intact. Overflow drops the oldest; chain.log stays authoritative.
 */
const HARNESS_SIGNAL_LIMIT = 1000;
const CHAIN_EVENT_LIMIT = 2000;

// `useUiState` doesn't export its return interface, so infer it locally.
type UiStateApi = ReturnType<typeof useUiState>;

interface ExecuteSessionData {
  readonly session: SessionRecord | undefined;
  readonly sessions: SessionManager;
  readonly sessionList: readonly SessionRecord[];
  readonly router: RouterApi;
  readonly ui: UiStateApi;
  readonly deps: AppDeps;
  readonly eventBus: AppDeps['eventBus'];
  readonly signals: readonly SignalBusEntry[];
  readonly logEntries: readonly LogEvent[];
  readonly chainEvents: readonly AppEvent[];
  readonly term: TerminalSize;
}

/**
 * Every hook that just wires this view to shared runtime context (session registry, event buses, deps, terminal size,
 * …) rather than deriving Execute-specific state.
 */
const useExecuteSessionData = (sessionId: string): ExecuteSessionData => {
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
  return { session, sessions, sessionList, router, ui, deps, eventBus, signals, logEntries, chainEvents, term };
};

interface DeriveTasksPanelInput {
  readonly pinnedSprintStale: boolean;
  readonly bucketed: BucketedExecution | undefined;
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly layout: ResponsiveLayout;
  readonly tasksInputActive: boolean;
  readonly now: number;
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly onOpenEvaluation: (taskId: string) => void;
}

interface DeriveTasksPanelResult {
  readonly tasksPanel: React.JSX.Element;
  // Named to match `ExecuteBodyProps` (`executionState` / `taskState`) so the caller can spread
  // this result straight onto `<ExecuteBody>` — see `ExecuteViewFrame` below.
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  /** Handed back verbatim because the ≥140-col sidebar layout builds its own panel and needs the handler itself. */
  readonly onOpenEvaluation: (taskId: string) => void;
}

const deriveTasksPanel = ({
  pinnedSprintStale,
  bucketed,
  descriptor,
  isRunning,
  layout,
  tasksInputActive,
  now,
  executionState,
  taskState,
  onOpenEvaluation,
}: DeriveTasksPanelInput): DeriveTasksPanelResult => {
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
      maxTasks={layout.tasksMaxBlocks}
      inputActive={tasksInputActive}
      now={now}
      taskState={taskState}
      onOpenEvaluation={onOpenEvaluation}
    />
  );

  return {
    tasksPanel,
    executionState: pinnedSprintStale ? undefined : executionState,
    taskState: pinnedSprintStale ? undefined : taskState,
    onOpenEvaluation,
  };
};

/** Rendered when `sessionId` has no matching entry in the registry (e.g. it was removed). */
const SessionNotFoundNotice = (): React.JSX.Element => (
  <ViewShell title="Implement" subtitle="(session not found)">
    <Box paddingX={spacing.indent}>
      <Text dimColor>The session id was not found in the registry. It may have been removed.</Text>
    </Box>
  </ViewShell>
);

/**
 * Not derived inside `useCancelScopeStats` itself so the O(chainEvents) scan that produces `attemptStartedAt` does
 * not re-run on every 1 Hz `useLiveClock` tick — only this cheap subtraction does.
 */
const computeAttemptElapsedMs = (attemptStartedAt: number | undefined, now: number): number | undefined =>
  attemptStartedAt !== undefined ? Math.max(0, now - attemptStartedAt) : undefined;

interface UseExecuteRunControlsInput {
  readonly descriptor: SessionDescriptor | undefined;
  readonly modalOpen: boolean;
  readonly router: RouterApi;
  /** Gates the settled `g progress` hint — the global chord no-ops without a sprint to open. */
  readonly hasPinnedSprint: boolean;
  /** Gates the `v evaluation` hint — the chord no-ops until some task has recorded a verdict. */
  readonly hasEvaluation: boolean;
  /**
   * Gates the settled-only `u unblock` hint — read off the SAME polled entities the Tasks panel's own chord resolves
   * against (`taskState`), never the bucketed chain signals.
   */
  readonly hasBlockedTask: boolean;
  /** `y` handler and its gate — see {@link useExecuteInput}. */
  readonly onCopyTask: () => void;
  readonly canCopyTask: boolean;
}

export interface ExecuteRunControls {
  readonly isRunning: boolean;
  readonly cancelScopeOpen: boolean;
  readonly setCancelScopeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly now: number;
}

/** Bundles three pieces of state that only make sense together: run liveness, the cancel-scope picker, the clock. */
const useExecuteRunControls = ({
  descriptor,
  modalOpen,
  router,
  hasPinnedSprint,
  hasEvaluation,
  hasBlockedTask,
  onCopyTask,
  canCopyTask,
}: UseExecuteRunControlsInput): ExecuteRunControls => {
  const isRunning = descriptor?.status === 'running';

  // The overlay claims the keyboard while mounted so the picker's `1` / `2` / `esc` keystrokes don't fight this
  // handler.
  const [cancelScopeOpen, setCancelScopeOpen] = React.useState(false);

  useExecuteInput({
    isRunning,
    cancelScopeOpen,
    setCancelScopeOpen,
    modalOpen,
    router,
    hasPinnedSprint,
    hasEvaluation,
    hasBlockedTask,
    onCopyTask,
    canCopyTask,
  });

  const now = useLiveClock(isRunning);

  return { isRunning, cancelScopeOpen, setCancelScopeOpen, now };
};

interface ExecuteViewFrameProps {
  readonly descriptor: SessionDescriptor;
  readonly sessionList: readonly SessionRecord[];
  readonly sessionId: string;
  readonly runControls: ExecuteRunControls;
  readonly layout: ResponsiveLayout;
  readonly term: TerminalSize;
  readonly bucketedTasks: BucketedDerivation;
  readonly tasksPanelDerivation: DeriveTasksPanelResult;
  readonly tokenUsage: TokenUsage | undefined;
  readonly logEntries: readonly LogEvent[];
  readonly attemptElapsedMs: number | undefined;
  readonly remainingTaskCount: number;
  readonly cancelHandlers: CancelHandlers;
  readonly pinnedSprintStale: boolean;
  readonly nextSteps: NextSteps;
}

/** The settled render for a found session — header chip + the full `ExecuteBody`. */
const ExecuteViewFrame = ({
  descriptor,
  sessionList,
  sessionId,
  runControls,
  layout,
  term,
  bucketedTasks,
  tasksPanelDerivation,
  tokenUsage,
  logEntries,
  attemptElapsedMs,
  remainingTaskCount,
  cancelHandlers,
  pinnedSprintStale,
  nextSteps,
}: ExecuteViewFrameProps): React.JSX.Element => {
  // Wall-clock elapsed since the run started — a display string for the header / footer.
  const endedAt = descriptor.finishedAt ?? runControls.now;
  const elapsed = fmtElapsed(descriptor.startedAt, endedAt);
  const awaiting = useAwaitingSessions();
  const waiting = runControls.isRunning && awaiting.has(sessionId);
  const statusLabel = waiting ? 'waiting' : descriptor.status;

  return (
    <ViewShell
      title={flowIdToTitle(descriptor.flowId)}
      crumb={flowIdToTitle(descriptor.flowId)}
      subtitle={sprintNameOf(descriptor.title)}
      // The Tasks panel owns ↑/↓ (and j/k) as its card / row cursor — without this the page ScrollRegion moved the
      // whole viewport on the same keypress that moved the cursor.
      suppressScrollArrows
      right={<StatusChip label={statusLabel} kind={waiting ? 'warning' : runnerStatusKind(descriptor.status)} />}
      // `[STATUS]` — the label's cells plus its brackets, so the location line can budget for it.
      rightWidth={statusLabel.length + 2}
    >
      <ExecuteBody
        descriptor={descriptor}
        sessionList={sessionList}
        sessionId={sessionId}
        isRunning={runControls.isRunning}
        now={runControls.now}
        elapsed={elapsed}
        layout={layout}
        termColumns={term.columns}
        termRows={term.rows}
        tokenUsage={tokenUsage}
        logEntries={logEntries}
        cancelScopeOpen={runControls.cancelScopeOpen}
        attemptElapsedMs={attemptElapsedMs}
        remainingTaskCount={remainingTaskCount}
        onCancelAttempt={cancelHandlers.onCancelAttempt}
        onCancelFlow={cancelHandlers.onCancelFlow}
        onDismissCancelScope={cancelHandlers.onDismiss}
        pinnedSprintStale={pinnedSprintStale}
        nextSteps={nextSteps}
        awaiting={awaiting}
        {...bucketedTasks}
        {...tasksPanelDerivation}
      />
    </ViewShell>
  );
};

interface BucketedTasksAndCopyInput {
  readonly descriptor: SessionDescriptor | undefined;
  readonly chainEvents: readonly AppEvent[];
  readonly signals: readonly SignalBusEntry[];
  readonly ui: UiStateApi;
  readonly eventBus: AppDeps['eventBus'];
}

/** The per-task derivation plus the Execute-local `y` handler that copies the active task's summary. */
const useBucketedTasksAndCopy = ({
  descriptor,
  chainEvents,
  signals,
  ui,
  eventBus,
}: BucketedTasksAndCopyInput): { readonly bucketedTasks: BucketedDerivation; readonly copyTask: () => void } => {
  const bucketedTasks = useBucketedTasks({ descriptor, chainEvents, signals, eventBus });
  const copyTask = useActiveTaskSummary({
    currentTask: bucketedTasks.currentTask,
    currentTaskName: bucketedTasks.currentTaskName,
    setActiveTaskSummaryProvider: ui.setActiveTaskSummaryProvider,
    getActiveTaskSummary: ui.getActiveTaskSummary,
    eventBus,
  });
  return { bucketedTasks, copyTask };
};

export const ExecuteView = (): React.JSX.Element => {
  const { sessionId } = useViewProps<ExecuteProps>();
  const { session, sessions, sessionList, router, ui, deps, eventBus, signals, logEntries, chainEvents, term } =
    useExecuteSessionData(sessionId);
  const selection = useSelection();

  // Each Execute view is scoped to its session's pinned sprint so concurrent runs remain
  // independent of each other and of the mutable global selection.
  const descriptor = session?.descriptor;
  const pinnedSprintId = descriptor?.pinnedSprintId as SprintId | undefined;

  // Everything derived from the pin: the availability probe + focused-run context + selection convergence, the polled
  // baseline-health entities, and the settled card's next steps / post-mortem paths.
  const { pinnedSprintStale, executionState, taskState, nextSteps } = useRunSprintContext({
    descriptor,
    pinnedSprintId,
    deps,
    setFocusedRunContext: ui.setFocusedRunContext,
    selectionSprintId: selection.sprintId,
    followFocusedRun: selection.followFocusedRun,
  });

  // `v` — the panel supplies the focused card id; this resolves the overlay target.
  const evaluation = useEvaluationChord({ sprintId: pinnedSprintId, taskState, openEvaluation: ui.openEvaluation });
  const { bucketedTasks, copyTask } = useBucketedTasksAndCopy({ descriptor, chainEvents, signals, ui, eventBus });
  const runControls = useExecuteRunControls({
    descriptor,
    modalOpen: ui.modalOpen,
    router,
    hasPinnedSprint: pinnedSprintId !== undefined,
    hasEvaluation: evaluation.hasAny,
    // `!pinnedSprintStale` mirrors the panel's own gate below — a stale pin unmounts the
    // `TasksPanelHost` that owns the `u` handler, so the hint must go with it.
    hasBlockedTask: !pinnedSprintStale && (taskState?.some((t) => t.status === 'blocked') ?? false),
    onCopyTask: copyTask,
    canCopyTask: bucketedTasks.currentTask !== undefined,
  });

  // Per-session token usage — latest `TokenUsageEvent` per sessionId. The execute view is
  // sessionId-scoped so we only look up the current runner's entry; absent ⇒ empty state.
  const tokenUsage = useTokenUsage(eventBus).get(sessionId);

  const cancelStats = useCancelScopeStats({
    chainEvents,
    currentTask: bucketedTasks.currentTask,
    bucketed: bucketedTasks.bucketed,
  });

  const cancelHandlers = useCancelHandlers({
    sessions,
    sessionId,
    sprintId: pinnedSprintId,
    currentTask: bucketedTasks.currentTask,
    taskRepo: deps.taskRepo,
    logger: deps.logger,
    setCancelScopeOpen: runControls.setCancelScopeOpen,
  });

  const layout = useResponsiveLayout({ columns: term.columns, rows: term.rows, isRunning: runControls.isRunning });

  // Early-return for "no session in registry" must come AFTER every hook above so the Hook call order is identical
  // across renders.
  if (!session || descriptor === undefined) return <SessionNotFoundNotice />;

  // `pinnedSprintStale` (closed/removed pin) is computed above, alongside the selection
  // convergence effect that also needs it.
  const tasksPanelDerivation = deriveTasksPanel({
    pinnedSprintStale,
    bucketed: bucketedTasks.bucketed,
    descriptor,
    isRunning: runControls.isRunning,
    layout,
    // TasksPanel claims input for its cursor chords (j/k, Enter/Space, `e`, `v`).
    tasksInputActive: !ui.modalOpen && !runControls.cancelScopeOpen,
    now: runControls.now,
    executionState,
    taskState,
    onOpenEvaluation: evaluation.open,
  });

  return (
    <ExecuteViewFrame
      descriptor={descriptor}
      sessionList={sessionList}
      sessionId={sessionId}
      runControls={runControls}
      layout={layout}
      term={term}
      bucketedTasks={bucketedTasks}
      tasksPanelDerivation={tasksPanelDerivation}
      tokenUsage={tokenUsage}
      logEntries={logEntries}
      attemptElapsedMs={computeAttemptElapsedMs(cancelStats.attemptStartedAt, runControls.now)}
      remainingTaskCount={cancelStats.remainingTaskCount}
      cancelHandlers={cancelHandlers}
      pinnedSprintStale={pinnedSprintStale}
      nextSteps={nextSteps}
    />
  );
};
