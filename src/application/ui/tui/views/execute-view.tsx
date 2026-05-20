/**
 * Implement view — live dashboard for an Implement chain run.
 *
 * Layout:
 *  - Header card (flow id, elapsed, steps, tasks done/total, status).
 *  - Wide (≥180 cols): three-column dashboard — fixed-width Flow Steps rail (left), flex-grow
 *    Tasks stream (centre), fixed-width Context column (right). The context column is empty
 *    on day-one and populated by later tasks (P2b token meter, P3a ETA, P1k baseline health).
 *  - Mid (≥140 cols): two-column — rail + flex Tasks stream. No context column.
 *  - Narrow (<140 cols): single-column stack — header, flow steps, tasks, log. Below 100 cols
 *    the Flow Steps section drops to `maxRows={4}` so the Tasks section keeps room to breathe.
 *
 * Naming: the chain-runner trace and the AppEvent buffer both carry the same milestones; the
 * dashboard merges them into one "Flow steps" surface. The historical separate "Progress" and
 * "Chain steps" sections were duplicating the same data.
 *
 * Local keys:
 *   c — open the cancel-scope picker (1 = cancel attempt, 2 = cancel whole flow)
 *   D — detach (return to home; the runner keeps running in the background)
 */

import React, { useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { Card } from '@src/application/ui/tui/components/card.tsx';
import { StatusChip, runnerStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';
import { StepTrace } from '@src/application/ui/tui/components/step-trace.tsx';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import { RecentEventsTail } from '@src/application/ui/tui/components/recent-events-tail.tsx';
import { ResultCard } from '@src/application/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import {
  COMPACT_RAIL_WIDTH,
  CONTEXT_WIDTH,
  RAIL_WIDTH,
  glyphs,
  inkColors,
  spacing,
} from '@src/application/ui/tui/theme/tokens.ts';
import { BaselineHealthCard } from '@src/application/ui/tui/components/baseline-health-card.tsx';
import { BaselineHealthChip } from '@src/application/ui/tui/components/baseline-health-chip.tsx';
import { TokenBudgetCard } from '@src/application/ui/tui/components/token-budget-card.tsx';
import { MultiFlowStrip } from '@src/application/ui/tui/components/multi-flow-strip.tsx';
import { useTokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { useViewProps, useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSession, useSessionManager, useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useBuses } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { useSinkStream } from '@src/application/ui/tui/runtime/use-sink-stream.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { useEventBusBuffer } from '@src/application/ui/tui/runtime/use-event-bus.ts';
import { useTaskRoundTracker } from '@src/application/ui/tui/runtime/use-task-round-tracker.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { bucketTaskSignals, isPerTaskLeaf } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';
import { renderActiveTaskSummary } from '@src/application/ui/tui/runtime/render-active-task-summary.ts';
import { CancelScopeOverlay } from '@src/application/ui/tui/components/cancel-scope-overlay.tsx';
import { cancelActiveTaskUseCase } from '@src/business/task/cancel-active-task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';

interface ExecuteProps extends Readonly<Record<string, unknown>> {
  readonly sessionId: string;
}

const TWO_COL_BREAKPOINT = 140;
const THREE_COL_BREAKPOINT = 180;
/**
 * Below this width the Flow Steps section collapses to four rows in single-column mode AND the
 * two-column layout disappears entirely (we never render the rail on a <100 col terminal — the
 * stream column wouldn't have room left). At 100-139 cols a *compact* rail variant (status
 * glyphs only, no labels) is rendered instead of the labelled rail used at ≥140 cols.
 */
const NARROW_FLOW_STEPS_BREAKPOINT = 100;
const NARROW_FLOW_STEPS_ROWS = 4;

const SectionHeader = ({ title }: { readonly title: string }): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Text dimColor bold>
      {glyphs.bullet} {title}
    </Text>
  </Box>
);

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <Box flexDirection="column" marginTop={spacing.section}>
    <SectionHeader title={title} />
    {children}
  </Box>
);

export const ExecuteView = (): React.JSX.Element => {
  const { sessionId } = useViewProps<ExecuteProps>();
  const session = useSession(sessionId);
  const sessions = useSessionManager();
  // Live list of every session for the multi-flow strip (renders only when ≥2 are running).
  const sessionList = useSessions();
  const router = useRouter();
  const ui = useUiState();
  const selection = useSelection();
  const buses = useBuses();
  // Buffer sizing for long Implement runs:
  //   - harness signals: ~20-40 per task (changes, learnings, decisions, commit messages, …)
  //     so 10 tasks × 30 = 300; 1000 keeps a healthy headroom and a multi-hour 20-task sprint.
  //   - log entries: chain steps + provider debug lines run hot. 1000 covers a long run; the
  //     full log lives on disk (<sprintDir>/chain.log) anyway, this buffer is just the tail.
  //   - chainEvents: drives per-task time windows in bucketTaskSignals. We need the EARLIEST
  //     events for early tasks to keep their signal correlation intact. 2000 covers ~15 tasks
  //     × ~12 substeps × ~5 gen-eval rounds + outer-flow leaves.
  // When a buffer overflows it drops the OLDEST entry. The on-disk chain.log is authoritative.
  const signals = useSinkStream(buses.harness, { limit: 1000 });
  const logEntries = useSinkStream(buses.log, { limit: 1000 });
  const deps = useDeps();
  const eventBus = deps.eventBus;
  const chainEvents = useEventBusBuffer<AppEvent>(eventBus, {
    filter: (e): e is AppEvent => 'chainId' in e && (e as { chainId: string }).chainId === sessionId,
    limit: 2000,
  });
  const term = useTerminalSize();

  // Baseline-health data — Sprint Execution + Task list, polled while the run is live so the
  // Card / Chip reflect the latest pre/post check-script rows as they land. We re-read on a
  // tight interval rather than wiring a dedicated bus channel because the persisted entities
  // are the source of truth (the chain leaves write to taskRepo / sprintExecutionRepo before
  // the bus event fires); polling keeps the wiring simple.
  const [executionState, setExecutionState] = React.useState<SprintExecution | undefined>(undefined);
  const [taskState, setTaskState] = React.useState<readonly Task[] | undefined>(undefined);
  const baselineSprintId: SprintId | undefined = selection.sprintId as SprintId | undefined;
  React.useEffect(() => {
    if (baselineSprintId === undefined) {
      setExecutionState(undefined);
      setTaskState(undefined);
      return undefined;
    }
    // Test bootstraps wire a partial AppDeps; guard so missing repos don't crash the view.
    const execRepo = deps.sprintExecutionRepo;
    const taskRepo = deps.taskRepo;
    if (execRepo === undefined || taskRepo === undefined) return undefined;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [execR, tasksR] = await Promise.all([
        execRepo.findById(baselineSprintId),
        taskRepo.findBySprintId(baselineSprintId),
      ]);
      if (cancelled) return;
      if (execR.ok) setExecutionState(execR.value);
      if (tasksR.ok) setTaskState(tasksR.value);
    };
    void load();
    // 3s cadence — fast enough that a fresh CheckRun row lands within the operator's reading
    // window, slow enough that the disk + JSON parse cost stays trivial even on a wide sprint.
    const id = setInterval(() => {
      void load();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baselineSprintId, deps.sprintExecutionRepo, deps.taskRepo]);

  const isRunning = session?.descriptor.status === 'running';

  // Cancel-scope picker — `c` no longer aborts immediately; it opens an inline overlay that
  // distinguishes "cancel current attempt" (keep task queued, retry next round) from "cancel
  // whole flow" (mark current task blocked + exit chain). The overlay claims the keyboard
  // while mounted so the picker's `1` / `2` / `esc` keystrokes don't fight this handler.
  const [cancelScopeOpen, setCancelScopeOpen] = React.useState(false);

  useViewHints(
    isRunning
      ? cancelScopeOpen
        ? [
            { keys: '1', label: 'cancel attempt' },
            { keys: '2', label: 'cancel whole flow' },
            { keys: 'esc', label: 'back to run' },
          ]
        : [
            { keys: 'c', label: 'cancel' },
            { keys: 'D', label: 'detach' },
          ]
      : [{ keys: '↵', label: 'back' }]
  );

  useInput((input, key) => {
    if (ui.helpOpen || ui.promptActive) return;
    if (!isRunning) {
      if (key.return || key.escape) {
        if (selection.sprintId !== undefined) {
          router.reset({ id: 'sprint-detail', props: { sprintId: selection.sprintId } });
        } else {
          router.pop();
        }
      }
      return;
    }
    if (input === 'c' && !cancelScopeOpen) setCancelScopeOpen(true);
    if (input === 'D') router.reset();
  });

  const [now, setNow] = React.useState<number>(() => Date.now());
  useEffect(() => {
    if (!isRunning) return undefined;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [isRunning]);

  const rawBucketed = useMemo(
    () =>
      session
        ? bucketTaskSignals(session.descriptor.trace, chainEvents, signals, {
            ...(session.descriptor.maxTurns !== undefined ? { maxTurns: session.descriptor.maxTurns } : {}),
            ...(session.descriptor.terminalSubstepName !== undefined
              ? { terminalSubstepName: session.descriptor.terminalSubstepName }
              : {}),
          })
        : undefined,
    [session, chainEvents, signals]
  );

  // Authoritative per-task round counter — sourced from `task-round-started` events on the
  // bus rather than counted from the trace. The trace is a ring buffer
  // (`MAX_TRACE_ENTRIES = 5_000`); counting `generator-<taskId>` entries silently
  // undercounts once early ones get evicted. The hook holds a monotonic high-water in its
  // own state so the event-driven source remains stable across re-renders, even if the bus's
  // own subscription stream missed earlier events (the hook only goes forward).
  const taskRounds = useTaskRoundTracker(eventBus);
  // Per-session token usage — latest `TokenUsageEvent` per sessionId. The execute view is
  // sessionId-scoped so we only look up the current runner's entry; absent ⇒ empty state.
  const tokenUsageBySession = useTokenUsage(eventBus);
  const tokenUsage = tokenUsageBySession.get(sessionId);
  const bucketed = useMemo(() => {
    if (rawBucketed === undefined) return undefined;
    const tasks = rawBucketed.tasks.map((t) => {
      const tracked = taskRounds.get(t.id);
      if (tracked === undefined) return t;
      // Latest-event-wins, but never regress below whatever the trace count derived (e.g. a
      // post-mortem view of an aborted runner with no incoming events still sees the bucketed
      // count from the descriptor's frozen trace).
      const roundN = Math.max(t.genEvalRound, tracked.roundN);
      return {
        ...t,
        genEvalRound: roundN,
        genEvalMaxRounds: tracked.totalCap,
      };
    });
    return { ...rawBucketed, tasks };
  }, [rawBucketed, taskRounds]);

  if (!session) {
    return (
      <ViewShell title="Implement" subtitle="(unknown session)">
        <Box paddingX={spacing.indent}>
          <Text dimColor>The session id was not found in the registry. It may have been removed.</Text>
        </Box>
      </ViewShell>
    );
  }

  const { descriptor } = session;
  const elapsed = fmtElapsed(descriptor.startedAt, descriptor.finishedAt ?? now);
  const tasksDone = bucketed?.tasks.filter((t) => t.status === 'completed').length ?? 0;
  const tasksTotal = bucketed?.tasks.length ?? 0;
  const threeColumn = term.columns >= THREE_COL_BREAKPOINT;
  const twoColumn = !threeColumn && term.columns >= TWO_COL_BREAKPOINT;
  // Intermediate breakpoint (100–139 cols): a compact two-column layout with the rail
  // collapsed to status glyphs (no labels). Below 100 cols we drop the rail entirely.
  const compactTwoColumn = !threeColumn && !twoColumn && term.columns >= NARROW_FLOW_STEPS_BREAKPOINT;
  const singleColumn = !threeColumn && !twoColumn && !compactTwoColumn;

  const baseFlowStepsRows = isRunning ? Math.max(8, term.rows - 22) : 16;
  const flowStepsRows = singleColumn ? NARROW_FLOW_STEPS_ROWS : baseFlowStepsRows;
  const tasksMaxSignals = isRunning ? 6 : 12;
  const logRows = isRunning ? 6 : 10;

  // Current task = the first non-completed one — which is `running` mid-task and `pending` in
  // the brief transition window between tasks. Completed/failed/aborted/skipped tasks are
  // behind the cursor; the per-task chain runs sequentially so the first non-completed task
  // is always the one in flight.
  const currentTaskIdx = bucketed?.tasks.findIndex((t) => t.status !== 'completed') ?? -1;
  const currentTask = currentTaskIdx >= 0 ? bucketed?.tasks[currentTaskIdx] : undefined;
  const currentTaskName =
    currentTask !== undefined
      ? (descriptor.taskNames?.get(currentTask.id) ?? `${currentTask.id.slice(0, 8)}…`)
      : undefined;
  const currentSubStep = currentTask?.subSteps[currentTask.subSteps.length - 1]?.leafName;

  // Register the active-task summary provider so the global `y` (yank) hotkey can copy a
  // markdown snapshot of whatever task the operator is currently watching. The provider closes
  // over the latest `currentTask` + display name; React re-runs the effect each render they
  // change, so the closure always reflects the current frame. Cleanup clears the registration
  // on unmount or when the deps change — important because the global handler reads the
  // provider through a ref and a stale closure would leak yesterday's task name into copies.
  useEffect(() => {
    if (currentTask === undefined || currentTaskName === undefined) {
      ui.setActiveTaskSummaryProvider(undefined);
      return undefined;
    }
    const task = currentTask;
    const displayName = currentTaskName;
    ui.setActiveTaskSummaryProvider(() => renderActiveTaskSummary({ task, displayName }));
    return () => {
      ui.setActiveTaskSummaryProvider(undefined);
    };
  }, [currentTask, currentTaskName, ui]);

  // Elapsed time on the latest attempt of the active task — drives the cancel-scope overlay's
  // "estimated wasted output" hint. Sourced from the most recent `task-attempt-started` event
  // matching the current task id. Falls back to undefined when no attempt has started yet
  // (e.g. preflight phase) — the overlay renders without the hint in that case.
  const attemptElapsedMs = useMemo<number | undefined>(() => {
    if (currentTask === undefined) return undefined;
    let latestStartMs: number | undefined;
    for (const ev of chainEvents) {
      if (ev.type !== 'task-attempt-started') continue;
      if (ev.taskId !== currentTask.id) continue;
      const ms = new Date(String(ev.at)).getTime();
      if (latestStartMs === undefined || ms > latestStartMs) latestStartMs = ms;
    }
    return latestStartMs !== undefined ? Math.max(0, now - latestStartMs) : undefined;
  }, [chainEvents, currentTask, now]);

  // Remaining tasks (including the in-flight one) — count of non-completed buckets. The
  // overlay reads this to surface "N other tasks still queued" on the flow-cancel option.
  const remainingTaskCount = useMemo<number>(() => {
    if (bucketed === undefined) return 0;
    return bucketed.tasks.reduce((n, t) => (t.status === 'completed' ? n : n + 1), 0);
  }, [bucketed]);

  // Cancel handlers — option 1 mirrors the previous `c` behaviour (chain-runner abort). Option
  // 2 marks the current task blocked with a fixed user-cancel reason, then aborts the chain so
  // the unwind is identical from the runner's perspective. The repo write happens BEFORE the
  // abort so a follow-up settle-attempt in the same tick can't overwrite our pin to `blocked`.
  const onCancelAttempt = React.useCallback(() => {
    setCancelScopeOpen(false);
    sessions.abort(sessionId);
  }, [sessions, sessionId]);

  const onCancelFlow = React.useCallback(() => {
    setCancelScopeOpen(false);
    void (async (): Promise<void> => {
      const sprintId = selection.sprintId as SprintId | undefined;
      const taskIdRaw = currentTask?.id;
      if (sprintId !== undefined && taskIdRaw !== undefined && deps.taskRepo !== undefined) {
        const taskId = taskIdRaw as TaskId;
        const found = await deps.taskRepo.findById(sprintId, taskId);
        if (found.ok) {
          await cancelActiveTaskUseCase({
            task: found.value,
            sprintId,
            reason: 'user cancel',
            taskRepo: deps.taskRepo,
            logger: deps.logger,
          });
        }
      }
      sessions.abort(sessionId);
    })();
  }, [sessions, sessionId, selection.sprintId, currentTask, deps.taskRepo, deps.logger]);

  const onDismissCancelScope = React.useCallback(() => {
    setCancelScopeOpen(false);
  }, []);

  const headerCard = (
    <Card title={descriptor.title} tone={isRunning ? 'info' : descriptor.status === 'completed' ? 'success' : 'rule'}>
      <Box flexDirection="column">
        <Box>
          <Text dimColor>flow </Text>
          <Text>{descriptor.flowId}</Text>
          <Text dimColor> {glyphs.bullet} elapsed </Text>
          <Text>{elapsed}</Text>
          {tasksTotal > 0 && (
            <>
              <Text dimColor> {glyphs.bullet} tasks </Text>
              {tasksDone === tasksTotal && tasksTotal > 0 ? (
                <Text color={inkColors.success}>
                  {String(tasksDone)}/{String(tasksTotal)}
                </Text>
              ) : (
                <Text>
                  {String(tasksDone)}/{String(tasksTotal)}
                </Text>
              )}
            </>
          )}
          {isRunning && (
            <Box marginLeft={2}>
              <Spinner active={isRunning} color={inkColors.info} label="live" />
            </Box>
          )}
        </Box>
        {currentTask !== undefined && currentTaskName !== undefined && (
          <Box>
            <Text dimColor>{glyphs.activityArrow} task </Text>
            <Text color={inkColors.info}>
              {String(currentTaskIdx + 1)}/{String(tasksTotal)}
            </Text>
            <Text dimColor> {glyphs.bullet} </Text>
            <Text bold>{currentTaskName}</Text>
            {currentSubStep !== undefined && (
              <>
                <Text dimColor> {glyphs.bullet} step </Text>
                <Text color={inkColors.highlight}>{currentSubStep}</Text>
              </>
            )}
            {currentTask.genEvalRound > 0 && (
              <>
                <Text dimColor> {glyphs.bullet} round </Text>
                <Text color={inkColors.info}>
                  {String(currentTask.genEvalRound)}
                  {currentTask.genEvalMaxRounds !== undefined ? `/${String(currentTask.genEvalMaxRounds)}` : ''}
                </Text>
              </>
            )}
          </Box>
        )}
      </Box>
    </Card>
  );

  // Top-level flow steps exclude per-task subchain leaves (any name carrying a uuid suffix) —
  // those render under the Tasks panel. The `with-repo-lock(…)` wrapper is plumbing the
  // operator never needs to see in the plan; it only lands in the trace on a lock-acquire
  // failure, in which case the failure surfaces through the Recent-log panel anyway.
  const outerFlowFilter = (name: string): boolean => !isPerTaskLeaf(name) && !name.startsWith('with-repo-lock(');

  const flowStepsPanel = (
    <StepTrace
      trace={descriptor.trace}
      running={isRunning}
      filter={outerFlowFilter}
      maxRows={flowStepsRows}
      {...(descriptor.plannedLeaves !== undefined ? { plan: descriptor.plannedLeaves } : {})}
      {...(isRunning && descriptor.plannedLeaves === undefined ? { inFlightLabel: 'awaiting next step…' } : {})}
    />
  );

  // Compact rail panel — icons-only variant used at the 100–139 col breakpoint. The
  // `inFlightLabel` is dropped because there's no room for any text anyway, and the rail's
  // job in compact mode is just "is the runner moving and which phase is it on".
  const compactFlowStepsPanel = (
    <StepTrace
      trace={descriptor.trace}
      running={isRunning}
      filter={outerFlowFilter}
      maxRows={flowStepsRows}
      compact
      {...(descriptor.plannedLeaves !== undefined ? { plan: descriptor.plannedLeaves } : {})}
    />
  );

  // TasksPanel claims input for the signal-row cursor (j/k or ↑/↓ to move, Enter / Space to
  // expand a commit-message row). Disabled while any modal owns the keyboard so the cursor
  // can't fight the help overlay (`?`), the progress overlay (`g`), or a prompt.
  const tasksInputActive = !ui.helpOpen && !ui.progressOpen && !ui.promptActive;

  // Lazy criteria loader bound to this sprint's audit workspace. The Tasks panel calls it once
  // per non-pending task and caches the result for the mount lifetime. Tests that don't wire a
  // sprint selection (or omit `readDoneCriteria` from the test bootstrap) fall through to
  // `undefined` here, which makes the panel skip the criteria UI entirely — no crash.
  const storage = useStorage();
  const readCriteria = useMemo(() => {
    const loader = deps.readDoneCriteria;
    if (loader === undefined || selection.sprintId === undefined) return undefined;
    const parsed = AbsolutePath.parse(join(String(storage.dataRoot), 'sprints', String(selection.sprintId)));
    if (!parsed.ok) return undefined;
    const sprintDir = parsed.value;
    return async (taskId: string): Promise<string | undefined> => loader(sprintDir, taskId);
  }, [deps.readDoneCriteria, selection.sprintId, storage.dataRoot]);

  const tasksPanel =
    bucketed !== undefined ? (
      <TasksPanel
        bucketed={bucketed}
        running={isRunning}
        maxSignalsPerTask={tasksMaxSignals}
        inputActive={tasksInputActive}
        nowMs={now}
        {...(descriptor.taskNames !== undefined ? { nameById: descriptor.taskNames } : {})}
        {...(descriptor.taskRecovering !== undefined ? { recoveringByTaskId: descriptor.taskRecovering } : {})}
        {...(readCriteria !== undefined ? { readDoneCriteria: readCriteria } : {})}
      />
    ) : null;

  const logPanel = <RecentEventsTail entries={logEntries} maxRows={logRows} />;

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
        <Box flexDirection="column">
          {/* Multi-flow chip strip — renders only when ≥2 sessions are running, so a single-
              flow run pays zero pixels. The strip shows `[N] · <flow>: <title> ⏱<elapsed>`
              chips with the current chip highlighted and a Tab/Shift+Tab cycle hint pinned
              to the right end. */}
          <MultiFlowStrip sessions={sessionList} activeId={sessionId} now={now} />
          {/* Baseline-health chip — sits above the active-task header so the verify-gate
              state is visible without scrolling. Always rendered; renders a neutral
              "awaiting first run" pill before the first leaf has touched the data. */}
          <Box paddingX={spacing.indent}>
            <BaselineHealthChip
              {...(executionState !== undefined ? { execution: executionState } : {})}
              {...(taskState !== undefined ? { tasks: taskState } : {})}
              now={now}
            />
          </Box>
          {headerCard}

          {threeColumn ? (
            <Box flexDirection="row" marginTop={spacing.section}>
              <Box flexDirection="column" width={RAIL_WIDTH} marginRight={spacing.section} flexShrink={0}>
                <SectionHeader title="Flow steps" />
                {flowStepsPanel}
              </Box>
              <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} marginRight={spacing.section}>
                <SectionHeader title="Tasks" />
                {tasksPanel}
              </Box>
              {/* Right context column — baseline-health card (P1k) on top, token-budget card
                  (P2b) below. P3a ETA stacks here in a later wave. */}
              <Box flexDirection="column" width={CONTEXT_WIDTH} flexShrink={0}>
                <BaselineHealthCard
                  {...(executionState !== undefined ? { execution: executionState } : {})}
                  {...(taskState !== undefined ? { tasks: taskState } : {})}
                  now={now}
                />
                <Box marginTop={spacing.section}>
                  <TokenBudgetCard sessionId={sessionId} {...(tokenUsage !== undefined ? { usage: tokenUsage } : {})} />
                </Box>
              </Box>
            </Box>
          ) : twoColumn ? (
            <Box flexDirection="row" marginTop={spacing.section}>
              <Box flexDirection="column" width={RAIL_WIDTH} marginRight={spacing.section} flexShrink={0}>
                <SectionHeader title="Flow steps" />
                {flowStepsPanel}
              </Box>
              <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
                <SectionHeader title="Tasks" />
                {tasksPanel}
              </Box>
            </Box>
          ) : compactTwoColumn ? (
            // 100–139 col breakpoint — compact rail (icons only, ~6 cols wide) + Tasks stream.
            // The rail's SectionHeader is dropped because "Flow steps" overflows the narrow
            // column; the glyph-only column reads as a status spine.
            <Box flexDirection="row" marginTop={spacing.section}>
              <Box flexDirection="column" width={COMPACT_RAIL_WIDTH} marginRight={spacing.section} flexShrink={0}>
                {compactFlowStepsPanel}
              </Box>
              <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
                <SectionHeader title="Tasks" />
                {tasksPanel}
              </Box>
            </Box>
          ) : (
            <>
              <Section title="Flow steps">{flowStepsPanel}</Section>
              <Section title="Tasks">{tasksPanel}</Section>
            </>
          )}

          <Section title="Recent log">{logPanel}</Section>

          {!isRunning && (
            <Box marginTop={spacing.section}>
              <ResultCard
                kind={
                  descriptor.status === 'completed' ? 'success' : descriptor.status === 'aborted' ? 'aborted' : 'failed'
                }
                title={descriptor.title}
                summary={descriptor.error?.message}
                fields={[
                  { label: 'Status', value: descriptor.status },
                  { label: 'Steps', value: String(descriptor.trace.length) },
                  { label: 'Tasks', value: `${String(tasksDone)}/${String(tasksTotal)}` },
                  { label: 'Elapsed', value: elapsed },
                ]}
              />
            </Box>
          )}

          {isRunning && (
            <Box paddingX={spacing.indent} marginTop={spacing.section}>
              <Spinner label="running…" />
            </Box>
          )}

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
      )}
    </ViewShell>
  );
};
