/**
 * Implement view — live dashboard for an Implement chain run.
 *
 * Layout:
 *  - Header card (flow id, elapsed, steps, tasks done/total, status).
 *  - Wide (≥140 cols): two-column dashboard — flow steps on the left, Tasks panel on the right
 *    (per-task sub-steps, evaluations, signals nested under their owning task; cross-task
 *    signals pinned at the top of the Tasks column). Log tail spans full width below.
 *  - Narrow (<140 cols): single-column stack — header, flow steps, tasks, log.
 *
 * Naming: the chain-runner trace and the AppEvent buffer both carry the same milestones; the
 * dashboard merges them into one "Flow steps" surface. The historical separate "Progress" and
 * "Chain steps" sections were duplicating the same data.
 *
 * Local keys:
 *   c — abort the running session
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
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useViewProps, useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSession, useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useBuses } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { useSinkStream } from '@src/application/ui/tui/runtime/use-sink-stream.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useEventBusBuffer } from '@src/application/ui/tui/runtime/use-event-bus.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { bucketTaskSignals, isPerTaskLeaf } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { fmtElapsed } from '@src/application/ui/tui/theme/duration.ts';

interface ExecuteProps extends Readonly<Record<string, unknown>> {
  readonly sessionId: string;
}

const TWO_COL_BREAKPOINT = 140;

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
  const eventBus = useDeps().eventBus;
  const chainEvents = useEventBusBuffer<AppEvent>(eventBus, {
    filter: (e): e is AppEvent => 'chainId' in e && (e as { chainId: string }).chainId === sessionId,
    limit: 2000,
  });
  const term = useTerminalSize();

  const isRunning = session?.descriptor.status === 'running';

  useViewHints(
    isRunning
      ? [
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
    if (input === 'c') sessions.abort(sessionId);
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

  // Monotonic per-task round counter — survives the chain runner's MAX_TRACE_ENTRIES ring
  // eviction. `countGeneratorTurns` inside bucketTaskSignals counts trace entries; on long runs
  // the earliest `generator-<taskId>` entries get evicted and the count would silently shrink.
  // Holding the high-water mark in a ref means `round N/M` only ever moves forward, regardless
  // of trace truncation.
  const roundsHighWaterRef = React.useRef<Map<string, number>>(new Map());
  const bucketed = useMemo(() => {
    if (rawBucketed === undefined) return undefined;
    const tasks = rawBucketed.tasks.map((t) => {
      const seen = roundsHighWaterRef.current.get(t.id) ?? 0;
      if (t.genEvalRound <= seen) return { ...t, genEvalRound: seen };
      roundsHighWaterRef.current.set(t.id, t.genEvalRound);
      return t;
    });
    return { ...rawBucketed, tasks };
  }, [rawBucketed]);

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
  const twoColumn = term.columns >= TWO_COL_BREAKPOINT;

  const flowStepsRows = isRunning ? Math.max(8, term.rows - 22) : 16;
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

  const tasksPanel =
    bucketed !== undefined ? (
      <TasksPanel
        bucketed={bucketed}
        running={isRunning}
        maxSignalsPerTask={tasksMaxSignals}
        {...(descriptor.taskNames !== undefined ? { nameById: descriptor.taskNames } : {})}
      />
    ) : null;

  const logPanel = <RecentEventsTail entries={logEntries} maxRows={logRows} />;

  return (
    <ViewShell
      title="Implement"
      subtitle={descriptor.title}
      right={<StatusChip label={descriptor.status} kind={runnerStatusKind(descriptor.status)} />}
    >
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : (
        <Box flexDirection="column">
          {headerCard}

          {twoColumn ? (
            <Box flexDirection="row" marginTop={spacing.section}>
              <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} marginRight={spacing.section}>
                <SectionHeader title="Flow steps" />
                {flowStepsPanel}
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
        </Box>
      )}
    </ViewShell>
  );
};
