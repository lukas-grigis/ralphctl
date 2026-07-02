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
import { type SignalBusEntry, useBuses } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { useSinkStream } from '@src/application/ui/tui/runtime/use-sink-stream.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useEventBusBuffer } from '@src/application/ui/tui/runtime/use-event-bus.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { useUiState, type FocusedRunCtx } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
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

interface UsePinnedSprintContextInput {
  readonly pinnedSprintId: SprintId | undefined;
  readonly pinnedProjectLabel: string | undefined;
  readonly pinnedSprintLabel: string | undefined;
  readonly sprintRepo: AppDeps['sprintRepo'];
  readonly setFocusedRunContext: (ctx: FocusedRunCtx | undefined) => void;
}

/**
 * Two effects scoped to the session's pinned sprint, extracted together because they share
 * the same trio of inputs (pinnedSprintId / pinnedProjectLabel / pinnedSprintLabel):
 *  - probes `sprintRepo` to detect a closed/removed sprint, surfaced as `pinnedSprintAvailable`
 *    so the caller can blank the panels that depend on it (see `deriveTasksPanel` below).
 *  - registers this run's project/sprint as the focused-run context so the breadcrumb and
 *    progress overlay reflect the run's own sprint while this view is mounted.
 */
const usePinnedSprintContext = ({
  pinnedSprintId,
  pinnedProjectLabel,
  pinnedSprintLabel,
  sprintRepo,
  setFocusedRunContext,
}: UsePinnedSprintContextInput): { pinnedSprintAvailable: boolean } => {
  const [pinnedSprintAvailable, setPinnedSprintAvailable] = React.useState(true);

  React.useEffect(() => {
    if (pinnedSprintId === undefined) return undefined;
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const r = await sprintRepo.findById(pinnedSprintId);
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
  }, [pinnedSprintId, sprintRepo]);

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

  return { pinnedSprintAvailable };
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
const useExecuteRunControls = ({ descriptor, modalOpen, router }: UseExecuteRunControlsInput): ExecuteRunControls => {
  const isRunning = descriptor?.status === 'running';

  // Cancel-scope picker — `c` no longer aborts immediately; it opens an inline overlay that
  // distinguishes "cancel current attempt" (keep task queued, retry next round) from "cancel
  // whole flow" (mark current task blocked + exit chain). The overlay claims the keyboard
  // while mounted so the picker's `1` / `2` / `esc` keystrokes don't fight this handler.
  const [cancelScopeOpen, setCancelScopeOpen] = React.useState(false);

  useExecuteInput({ isRunning, cancelScopeOpen, setCancelScopeOpen, modalOpen, router });

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

  // Each Execute view is scoped to its session's pinned sprint so concurrent runs remain
  // independent of each other and of the mutable global selection.
  const descriptor = session?.descriptor;
  const pinnedSprintId = descriptor?.pinnedSprintId as SprintId | undefined;
  const pinnedProjectLabel = descriptor?.pinnedProjectLabel;
  const pinnedSprintLabel = descriptor?.pinnedSprintLabel;

  // Probes sprintRepo (best-effort — mark unavailable when closed/removed so the Execute
  // view can show an inline fallback instead of stale panel data) and registers this run's
  // pinned project/sprint as the focused-run context so breadcrumb and progress overlay
  // reflect the run's own sprint while this view is mounted.
  const { pinnedSprintAvailable } = usePinnedSprintContext({
    pinnedSprintId,
    pinnedProjectLabel,
    pinnedSprintLabel,
    sprintRepo: deps.sprintRepo,
    setFocusedRunContext: ui.setFocusedRunContext,
  });

  // NOTE deliberately NO selection convergence here: focusing a run (Tab / Ctrl+1..9 /
  // Sessions-open) is a *browse*, exactly like opening a project or sprint detail — it must
  // never mutate (or persist) the global project/sprint selection. The user's pick survives
  // until they explicitly pick something else; the focused-run context above already scopes
  // the breadcrumb / overlay to the run's own sprint while this view is mounted.

  const { executionState, taskState } = useBaselineHealthData({
    baselineSprintId: pinnedSprintId,
    sprintExecutionRepo: deps.sprintExecutionRepo,
    taskRepo: deps.taskRepo,
  });

  const runControls = useExecuteRunControls({ descriptor, modalOpen: ui.modalOpen, router });

  const bucketedTasks = useBucketedTasks({ descriptor, chainEvents, signals, eventBus });

  // Per-session token usage — latest `TokenUsageEvent` per sessionId. The execute view is
  // sessionId-scoped so we only look up the current runner's entry; absent ⇒ empty state.
  const tokenUsageBySession = useTokenUsage(eventBus);
  const tokenUsage = tokenUsageBySession.get(sessionId);

  // Stash the stable setter so the active-task-summary effect doesn't fire on unrelated
  // UI state toggles (helpOpen, claims, …).
  const setActiveTaskSummaryProvider = ui.setActiveTaskSummaryProvider;
  useActiveTaskSummary({
    currentTask: bucketedTasks.currentTask,
    currentTaskName: bucketedTasks.currentTaskName,
    setActiveTaskSummaryProvider,
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

  // TasksPanel claims input for the signal-row cursor (j/k or ↑/↓ to move, Enter / Space to
  // expand a commit-message row). Disabled while any modal owns the keyboard so the cursor
  // can't fight the help overlay (`?`), the progress overlay (`g`), a prompt, or the
  // cancel-scope picker (`c`) — the latter is rendered inline behind the modal, so without
  // this gate esc/j/k/e would double-handle the hidden panel.
  const tasksInputActive = !ui.modalOpen && !runControls.cancelScopeOpen;

  // The pinned sprint is stale once it's been closed or removed — see `deriveTasksPanel`.
  const pinnedSprintStale = pinnedSprintId !== undefined && !pinnedSprintAvailable;

  const tasksPanelDerivation = deriveTasksPanel({
    pinnedSprintStale,
    bucketed: bucketedTasks.bucketed,
    descriptor,
    isRunning: runControls.isRunning,
    layout,
    tasksInputActive,
    now: runControls.now,
    executionState,
    taskState,
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
    />
  );
};
