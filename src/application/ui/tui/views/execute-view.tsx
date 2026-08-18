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
 *   - `use-pinned-sprint-context.ts` — pin availability probe, focused-run context, selection converge
 *   - `use-run-sprint-context.ts`    — the three pin-derived hooks in one call
 *   - `use-run-forensics.ts`         — existence-checked post-mortem paths for a failed run
 *   - `use-settled-next-steps.ts`    — session data → `buildNextSteps` input bag
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
 *   r — (settled only) reset to Flows so the launch triggers are re-evaluated
 *   v — open the focused task's evaluation verdict (owned by the Tasks panel's keymap)
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
import { type SignalBusEntry, useBuses } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { useSinkStream } from '@src/application/ui/tui/runtime/use-sink-stream.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useEventBusBuffer } from '@src/application/ui/tui/runtime/use-event-bus.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
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
 * Human-readable section title per flow id. Keeps the Execute view header accurate for any
 * flow that reuses this view (refine, plan, review, create-pr, …) instead of always showing
 * "Implement".
 */
const FLOW_TITLES: Record<string, string> = {
  implement: 'Implement',
  refine: 'Refine',
  plan: 'Plan',
  ideate: 'Ideate',
  review: 'Review',
  'create-pr': 'Create PR',
  readiness: 'Readiness',
  'detect-scripts': 'Detect Scripts',
  'detect-skills': 'Detect Skills',
  'create-sprint': 'Create Sprint',
  'close-sprint': 'Close Sprint',
  'add-ticket': 'Add Ticket',
  'remove-ticket': 'Remove Ticket',
  'export-context': 'Export Context',
  'export-requirements': 'Export Requirements',
  doctor: 'Doctor',
  settings: 'Settings',
};

/**
 * Derive a human-readable section title from a flow id. Falls back to the raw flowId so a
 * future flow never shows a blank header.
 */
const flowIdToTitle = (flowId: string): string => FLOW_TITLES[flowId] ?? flowId;

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
 * Every hook that just wires this view to shared runtime context (session registry, event
 * buses, deps, terminal size, …) rather than deriving Execute-specific state. Grouped into one
 * call so the component body reads as "get my wiring, then derive my state" instead of a long
 * flat prelude — the individual hooks are unchanged, still called in the same relative order.
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
}

/**
 * When the pinned sprint is no longer available (done or removed), blank the panels that
 * depend on it and surface a pick-a-sprint prompt so the user knows what happened.
 */
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
 * Not derived inside `useCancelScopeStats` itself so the O(chainEvents) scan that produces
 * `attemptStartedAt` does not re-run on every 1 Hz `useLiveClock` tick — only this cheap
 * subtraction does. `Math.max` guards the initial render: `now` (`useLiveClock`'s `Date.now()`
 * seed) can be fractionally behind an attempt timestamp parsed in the same tick, yielding a
 * small negative delta we clamp to 0.
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
}

export interface ExecuteRunControls {
  readonly isRunning: boolean;
  readonly cancelScopeOpen: boolean;
  readonly setCancelScopeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly now: number;
}

/**
 * Bundles the three pieces of state/derivation that only make sense together: whether the run
 * is live, the cancel-scope picker's open/closed state (claimed by `useExecuteInput`'s `c` key),
 * and the 1 Hz clock that only ticks while running.
 */
const useExecuteRunControls = ({
  descriptor,
  modalOpen,
  router,
  hasPinnedSprint,
  hasEvaluation,
}: UseExecuteRunControlsInput): ExecuteRunControls => {
  const isRunning = descriptor?.status === 'running';

  // Cancel-scope picker — `c` no longer aborts immediately; it opens an inline overlay that
  // distinguishes "cancel current attempt" (keep task queued, retry next round) from "cancel
  // whole flow" (mark current task blocked + exit chain). The overlay claims the keyboard
  // while mounted so the picker's `1` / `2` / `esc` keystrokes don't fight this handler.
  const [cancelScopeOpen, setCancelScopeOpen] = React.useState(false);

  useExecuteInput({
    isRunning,
    cancelScopeOpen,
    setCancelScopeOpen,
    modalOpen,
    router,
    hasPinnedSprint,
    hasEvaluation,
  });

  const now = useLiveClock(isRunning);

  return { isRunning, cancelScopeOpen, setCancelScopeOpen, now };
};

interface ExecuteViewFrameProps {
  readonly ui: UiStateApi;
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

/**
 * The settled render for a found session — header chip + either the help overlay or the full
 * `ExecuteBody`. Takes the grouped hook results as-is (rather than 20+ flat props) so the
 * caller reads as "assemble the frame from what I already computed".
 */
const ExecuteViewFrame = ({
  ui,
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

  return (
    <ViewShell
      title={flowIdToTitle(descriptor.flowId)}
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
          {...bucketedTasks}
          {...tasksPanelDerivation}
        />
      )}
    </ViewShell>
  );
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

  // Everything derived from the pin: the availability probe + focused-run context + selection
  // convergence, the polled baseline-health entities, and the settled card's next steps /
  // post-mortem paths. See `use-run-sprint-context.ts` for why the three travel together.
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
  const runControls = useExecuteRunControls({
    descriptor,
    modalOpen: ui.modalOpen,
    router,
    hasPinnedSprint: pinnedSprintId !== undefined,
    hasEvaluation: evaluation.hasAny,
  });

  const bucketedTasks = useBucketedTasks({ descriptor, chainEvents, signals, eventBus });

  // Per-session token usage — latest `TokenUsageEvent` per sessionId. The execute view is
  // sessionId-scoped so we only look up the current runner's entry; absent ⇒ empty state.
  const tokenUsage = useTokenUsage(eventBus).get(sessionId);

  useActiveTaskSummary({
    currentTask: bucketedTasks.currentTask,
    currentTaskName: bucketedTasks.currentTaskName,
    // The setter is its own stable `useCallback`, so reading it off the merged `ui` object does
    // not re-fire the effect when an unrelated overlay toggle changes that object's identity.
    setActiveTaskSummaryProvider: ui.setActiveTaskSummaryProvider,
  });

  const cancelStats = useCancelScopeStats({
    chainEvents,
    currentTask: bucketedTasks.currentTask,
    bucketed: bucketedTasks.bucketed,
  });
  const attemptElapsedMs = computeAttemptElapsedMs(cancelStats.attemptStartedAt, runControls.now);

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

  // Early-return for "no session in registry" must come AFTER every hook above so the Hook
  // call order is identical across renders. Hooks below this line do not exist — every Hook
  // the view needs has already run.
  if (!session || descriptor === undefined) return <SessionNotFoundNotice />;

  // `pinnedSprintStale` (closed/removed pin) is computed above, alongside the selection
  // convergence effect that also needs it.
  const tasksPanelDerivation = deriveTasksPanel({
    pinnedSprintStale,
    bucketed: bucketedTasks.bucketed,
    descriptor,
    isRunning: runControls.isRunning,
    layout,
    // TasksPanel claims input for its cursor chords (j/k, Enter/Space, `e`, `v`). Disabled while
    // any modal owns the keyboard — help (`?`), progress (`g`), evaluation (`v`), a prompt, or the
    // inline cancel-scope picker (`c`) — else the hidden panel double-handles every keystroke.
    tasksInputActive: !ui.modalOpen && !runControls.cancelScopeOpen,
    now: runControls.now,
    executionState,
    taskState,
    onOpenEvaluation: evaluation.open,
  });

  return (
    <ExecuteViewFrame
      ui={ui}
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
      attemptElapsedMs={attemptElapsedMs}
      remainingTaskCount={cancelStats.remainingTaskCount}
      cancelHandlers={cancelHandlers}
      pinnedSprintStale={pinnedSprintStale}
      nextSteps={nextSteps}
    />
  );
};
