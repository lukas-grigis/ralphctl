/**
 * ExecuteView — live dashboard for a sprint execution.
 *
 * Two attach modes:
 *   - When `executionId` is supplied, the view attaches to the existing
 *     registry entry, subscribing to its scoped `SignalBusPort` and scoped
 *     `LogEventBus`. This is how the user returns to a backgrounded run from
 *     the running-executions list.
 *   - Otherwise, the view starts a new execution via
 *     `ExecutionRegistryPort.start()` and attaches to the freshly-created
 *     entry. An `ExecutionAlreadyRunningError` surfaces as an inline error
 *     card offering a deep-link to the live execution.
 *
 * Navigation is handled by the surrounding `<ViewRouter />`. Crucially, this
 * view does NOT auto-pop back to home on completion — the execution remains
 * reachable from the running-executions list even after it terminates, and
 * the user chooses when to leave. Pressing `c` while the execution is running
 * requests cancellation via `registry.cancel(executionId)`.
 *
 * Settings edits flow through `PersistencePort.saveConfig()` and the next
 * task picked up from the queue reads fresh config (live-config invariant).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { HarnessEvent } from '@src/business/ports/signal-bus.ts';
import type { RunningExecution } from '@src/business/ports/execution-registry.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import { ExecutionAlreadyRunningError } from '@src/domain/errors.ts';
import { getPrompt, getSharedDeps } from '@src/integration/bootstrap.ts';
import { areAllTasksDone } from '@src/integration/persistence/task.ts';
import { closeSprint } from '@src/integration/persistence/sprint.ts';
import { useLoggerEvents, useRegistryEvents, useSignalEvents } from '@src/integration/ui/tui/runtime/hooks.ts';
import { TaskGrid } from '@src/integration/ui/tui/components/task-grid.tsx';
import { SprintSummary } from '@src/integration/ui/tui/components/sprint-summary.tsx';
import { LogTail } from '@src/integration/ui/tui/components/log-tail.tsx';
import { RateLimitBanner } from '@src/integration/ui/tui/components/rate-limit-banner.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { useRouter } from './router-context.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import type { ExecutionSummary } from '@src/business/usecases/execute.ts';

const EXECUTE_HINTS_RUNNING = [{ key: 'c', action: 'cancel' }] as const;
const EXECUTE_HINTS_TERMINAL = [{ key: 'Enter', action: 'back' }] as const;

/**
 * Fixed row overhead consumed by the execute view's non-log chrome on a
 * terminal-state screen (error card visible). Counted conservatively:
 *
 *   1  SectionStamp header
 *   1  section margin (spacing.section = 1)
 *   1  sprint name row
 *   1  section margin
 *   1  SprintSummary
 *   1  section margin
 *   5  TaskGrid (minimum rows assumed — variable, but we need a floor)
 *   1  section margin
 *   1  log "── Log ───" header row (inside LogTail)
 *   3  error card minimum (glyph+title + step field + 1 msg line)
 *   1  KeyboardHints row
 *   1  StatusBar row
 *   2  safety margin
 *  ──
 *  20  fixed overhead
 *
 * Remaining rows (`terminalRows - FIXED_OVERHEAD`) are given to the log tail.
 * The floor of 3 ensures at least a sliver of context is visible even on tiny
 * terminals.
 */
const LOG_TAIL_FIXED_OVERHEAD = 20;
/** Minimum log lines shown even on very small terminals. */
const LOG_TAIL_MIN_LINES = 3;
/** Default when terminal height is unknown (non-TTY / tests). */
const LOG_TAIL_DEFAULT_LINES = 8;
/** Maximum characters from an error message before truncating in the ResultCard. */
const ERROR_MESSAGE_MAX_LINES = 20;

interface Props {
  sprintId: string;
  /**
   * When provided, attach to the existing registry entry instead of starting
   * a new execution. Passed by the running-executions list.
   */
  executionId?: string;
  executionOptions?: ExecutionOptions;
}

interface RunState {
  sprint: Sprint | null;
  tasks: readonly Task[];
  running: Set<string>;
  blocked: Set<string>;
  activity: Map<string, string>;
  currentStep: Map<string, string>;
  rateLimit: { pausedSince: Date; delayMs: number } | null;
  taskRefreshError: string | null;
}

export function initialState(): RunState {
  return {
    sprint: null,
    tasks: [],
    running: new Set(),
    blocked: new Set(),
    activity: new Map(),
    currentStep: new Map(),
    rateLimit: null,
    taskRefreshError: null,
  };
}

interface AttachState {
  kind: 'attaching' | 'attached' | 'collision' | 'error';
  execution: RunningExecution | null;
  collisionId: string | null;
  errorMessage: string | null;
}

const initialAttach: AttachState = {
  kind: 'attaching',
  execution: null,
  collisionId: null,
  errorMessage: null,
};

export function ExecuteView({ sprintId, executionId, executionOptions }: Props): React.JSX.Element {
  const router = useRouter();
  const shared = getSharedDeps();
  const registry = shared.executionRegistry;
  const registryEvents = useRegistryEvents(registry);
  const [attach, setAttach] = useState<AttachState>(initialAttach);
  const [state, setState] = useState(initialState);
  const { stdout } = useStdout();
  const processedCountRef = useRef(0);
  const startedRef = useRef(false);

  // Resolve the execution we are attached to on every registry transition.
  // When given an `executionId` we look it up directly; otherwise we rely on
  // the start effect below to create the entry and store its id.
  const attachedId = attach.execution?.id ?? null;
  const liveExecution = useMemo<RunningExecution | null>(() => {
    if (attachedId === null) return null;
    return registry.get(attachedId);
  }, [attachedId, registry, registryEvents]);

  // Attach OR start. We guard with a ref so a re-render does not try to
  // spawn a second execution.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (executionId !== undefined) {
      const existing = registry.get(executionId);
      if (existing === null) {
        setAttach({
          kind: 'error',
          execution: null,
          collisionId: null,
          errorMessage: `Execution ${executionId} is no longer tracked.`,
        });
        return;
      }
      setAttach({ kind: 'attached', execution: existing, collisionId: null, errorMessage: null });
      return;
    }

    void (async () => {
      try {
        const execution = await registry.start({ sprintId, options: executionOptions });
        setAttach({ kind: 'attached', execution, collisionId: null, errorMessage: null });
      } catch (err) {
        if (err instanceof ExecutionAlreadyRunningError) {
          setAttach({
            kind: 'collision',
            execution: null,
            collisionId: err.existingExecutionId,
            errorMessage: err.message,
          });
          return;
        }
        setAttach({
          kind: 'error',
          execution: null,
          collisionId: null,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, [executionId, executionOptions, registry, sprintId]);

  const scopedSignalBus = useMemo(() => {
    if (attachedId === null) return null;
    return registry.getSignalBus(attachedId);
  }, [attachedId, registry]);

  const scopedLogEventBus = useMemo(() => {
    if (attachedId === null) return null;
    return registry.getLogEventBus(attachedId);
  }, [attachedId, registry]);

  const signalEvents = useSignalEvents(scopedSignalBus);
  const logEvents = useLoggerEvents(200, scopedLogEventBus);

  // Load sprint + tasks once the sprint id resolves. We capture the sprint
  // snapshot from the registry when attached, which is immutable; otherwise
  // we fall back to persistence.
  useEffect(() => {
    const cancel = { current: false };
    void (async () => {
      try {
        if (liveExecution) {
          if (!cancel.current) {
            setState((s) => ({ ...s, sprint: liveExecution.sprint }));
          }
        }
        const tasks = await shared.persistence.getTasks(sprintId);
        if (!cancel.current) setState((s) => ({ ...s, tasks }));
      } catch (err) {
        if (!cancel.current) {
          setState((s) => ({ ...s, taskRefreshError: err instanceof Error ? err.message : String(err) }));
        }
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, [liveExecution, shared, sprintId]);

  // Reduce only the new events — the buffer is rolling, so we track the
  // length already consumed in a ref. Reset when the source bus changes (e.g.
  // on remount for a different execution).
  useEffect(() => {
    processedCountRef.current = 0;
  }, [scopedSignalBus]);

  useEffect(() => {
    if (signalEvents.length <= processedCountRef.current) return;
    const fresh = signalEvents.slice(processedCountRef.current);
    processedCountRef.current = signalEvents.length;
    setState((prev) => reduceEvents(prev, fresh));

    if (fresh.some((e) => e.type === 'task-finished')) {
      void (async () => {
        try {
          const tasks = await shared.persistence.getTasks(sprintId);
          setState((s) => ({ ...s, tasks }));
        } catch {
          // Leave the grid as-is; next refresh will catch up.
        }
      })();
    }
  }, [signalEvents, shared, sprintId]);

  // Derive how many log lines fit in the viewport. `stdout.rows` is the live
  // terminal height (undefined in non-TTY / test environments). We subtract
  // the fixed chrome budget to leave what's left for the log. The result is
  // clamped to at least LOG_TAIL_MIN_LINES so tiny terminals still see context.
  const logVisibleLines = stdout.rows
    ? Math.max(LOG_TAIL_MIN_LINES, stdout.rows - LOG_TAIL_FIXED_OVERHEAD)
    : LOG_TAIL_DEFAULT_LINES;

  const status = liveExecution?.status ?? 'running';
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const [closePromptRun, setClosePromptRun] = useState(false);

  // On terminal transition, refresh the task grid one last time and prompt
  // the user whether to close the sprint (only if fully done).
  useEffect(() => {
    if (!terminal) return;
    if (closePromptRun) return;
    setClosePromptRun(true);
    void (async () => {
      try {
        const tasks = await shared.persistence.getTasks(sprintId);
        setState((s) => ({ ...s, tasks }));
      } catch {
        // Leave the in-memory view as-is.
      }

      const summary: ExecutionSummary | undefined = liveExecution ? liveExecution.summary : undefined;
      if (
        summary?.stopReason === 'all_completed' &&
        summary.remaining === 0 &&
        summary.completed > 0 &&
        (await areAllTasksDone(sprintId))
      ) {
        try {
          const shouldClose = await getPrompt().confirm({
            message: 'Close the sprint?',
            default: true,
          });
          if (shouldClose) await closeSprint(sprintId);
        } catch {
          // Cancellation or validation failure — leave the sprint open.
        }
      }
    })();
  }, [terminal, closePromptRun, shared, sprintId, liveExecution]);

  // View-local keys:
  //   - `c` while running → cancel via the registry (keeps the user on-view)
  //   - Enter on a terminal execution → pop back to the previous frame
  //
  // Log scrolling is intentionally absent. The log auto-tails to its end so
  // the user always sees the most recent events without any interaction.
  // Full output is available in the sprint's progress.md.
  useInput((input, key) => {
    if (attach.kind === 'attached' && liveExecution?.status === 'running' && input === 'c') {
      registry.cancel(liveExecution.id);
      return;
    }
    if (terminal && key.return) {
      router.pop();
    }
  });

  useViewHints(terminal ? EXECUTE_HINTS_TERMINAL : EXECUTE_HINTS_RUNNING);

  if (attach.kind === 'collision') {
    return (
      <ViewShell title="Execute">
        <ResultCard
          kind="warning"
          title="Execution already running"
          lines={[attach.errorMessage ?? 'A run is already in progress for this project.']}
          nextSteps={[
            {
              action: 'Press Enter to view the running execution',
              description: 'The harness keeps one execution per project.',
            },
          ]}
        />
        <CollisionRedirect registry={registry} collisionId={attach.collisionId} fallbackSprintId={sprintId} />
      </ViewShell>
    );
  }

  if (attach.kind === 'error') {
    return (
      <ViewShell title="Execute">
        <ResultCard
          kind="error"
          title="Could not attach to execution"
          lines={[attach.errorMessage ?? 'Unknown error.']}
        />
      </ViewShell>
    );
  }

  if (attach.kind === 'attaching') {
    return (
      <ViewShell title="Execute">
        <Spinner label="Attaching to execution…" />
      </ViewShell>
    );
  }

  // Build error card content — truncate very long messages so the ResultCard
  // stays readable. The full output is always in the log tail below.
  const errorCard =
    terminal && liveExecution?.status === 'failed' && liveExecution.error ? buildErrorCard(liveExecution.error) : null;

  return (
    <ViewShell title="Execute">
      <Box>
        <Text bold color={inkColors.primary}>
          {state.sprint?.name ?? 'Sprint'}
        </Text>
        <Text dimColor>
          {'  '}
          {state.sprint?.branch ? `[${state.sprint.branch}]` : ''}
          {'  '}
          {state.sprint?.status ? `(${state.sprint.status})` : ''}
        </Text>
      </Box>

      <Box marginTop={spacing.section}>
        <SprintSummary tasks={state.tasks} />
      </Box>

      {state.rateLimit ? (
        <Box marginTop={spacing.section}>
          <RateLimitBanner pausedSince={state.rateLimit.pausedSince} delayMs={state.rateLimit.delayMs} />
        </Box>
      ) : null}

      <Box marginTop={spacing.section}>
        <TaskGrid
          tasks={state.tasks}
          runningTaskIds={state.running}
          blockedTaskIds={state.blocked}
          activityByTask={state.activity}
        />
      </Box>

      {!terminal && state.currentStep.size > 0 ? (
        <Box marginTop={spacing.section} flexDirection="column">
          {Array.from(state.currentStep.entries()).map(([taskId, label]) => {
            const task = state.tasks.find((t) => t.id === taskId);
            const taskName = task?.name ?? taskId.slice(0, 8);
            return <Spinner key={taskId} label={`${taskName} ${glyphs.emDash} ${label}`} />;
          })}
        </Box>
      ) : null}

      {/* Log tail — always rendered first (above the outcome card) so that on a
          terminal transition the card lands at the bottom of the viewport, just
          above the hints/status-bar chrome. The tail auto-sticks to its end so
          the user sees the most-recent events with no key interaction needed.
          `logVisibleLines` is computed from the live terminal height so the
          log never pushes the card into terminal scrollback. */}
      <Box marginTop={spacing.section}>
        <LogTail events={logEvents} visibleLines={logVisibleLines} scrollOffset={0} />
      </Box>

      {/* Terminal outcome block — rendered AFTER the log tail so it is pinned
          at the bottom of the viewport (just above hints) when a run finishes. */}
      {terminal && liveExecution ? (
        <Box marginTop={spacing.section} flexDirection="column">
          {errorCard ? (
            <ResultCard kind="error" title="Execution failed" fields={errorCard.fields} lines={errorCard.lines} />
          ) : (
            <>
              <Text color={terminalColor(liveExecution.status)} bold>
                {terminalGlyph(liveExecution.status)} Execution {liveExecution.status}
              </Text>
              {liveExecution.summary ? (
                <Text dimColor>
                  {liveExecution.summary.completed} completed {glyphs.inlineDot} {liveExecution.summary.remaining}{' '}
                  remaining {glyphs.inlineDot} {liveExecution.summary.blocked} blocked
                  {'  ('}
                  {liveExecution.summary.stopReason}
                  {')'}
                </Text>
              ) : null}
            </>
          )}
        </Box>
      ) : null}
    </ViewShell>
  );
}

function terminalColor(status: RunningExecution['status']): string {
  if (status === 'completed') return inkColors.success;
  if (status === 'failed') return inkColors.error;
  return inkColors.muted;
}

function terminalGlyph(status: RunningExecution['status']): string {
  if (status === 'completed') return glyphs.check;
  if (status === 'failed') return glyphs.cross;
  return glyphs.warningGlyph;
}

/**
 * Build the fields + lines for a failure ResultCard. Truncates the error
 * message to the LAST ERROR_MESSAGE_MAX_LINES lines — build tools (Maven,
 * pnpm, etc.) report the actual failure at the tail of their output, so
 * head-truncation would show only banners and dependency resolution noise.
 *
 * Exported for unit testing.
 */
export function buildErrorCard(error: NonNullable<RunningExecution['error']>): {
  fields: [string, string][] | undefined;
  lines: string[];
} {
  const fields: [string, string][] | undefined = error.stepName ? [['Step', error.stepName]] : undefined;
  const rawLines = error.message.split('\n');
  if (rawLines.length <= ERROR_MESSAGE_MAX_LINES) {
    return { fields, lines: rawLines };
  }
  const hidden = rawLines.length - ERROR_MESSAGE_MAX_LINES;
  const visibleLines = [
    `(${String(hidden)} earlier line${hidden !== 1 ? 's' : ''} omitted)`,
    ...rawLines.slice(-ERROR_MESSAGE_MAX_LINES),
  ];
  return { fields, lines: visibleLines };
}

interface CollisionProps {
  readonly registry: import('@src/business/ports/execution-registry.ts').ExecutionRegistryPort;
  readonly collisionId: string | null;
  /** Sprint to fall back on when the existing execution is not retrievable. */
  readonly fallbackSprintId: string;
}

function CollisionRedirect({ registry, collisionId, fallbackSprintId }: CollisionProps): React.JSX.Element | null {
  const router = useRouter();
  useInput((_input, key) => {
    if (!collisionId) return;
    if (key.return) {
      // Redirect to the *existing* execution's sprint, not the one the user
      // attempted to start — the collision error means there's an active run
      // for the project (possibly on a different sprint).
      const existingSprintId = registry.get(collisionId)?.sprintId ?? fallbackSprintId;
      router.replace({
        id: 'execute',
        props: { sprintId: existingSprintId, executionId: collisionId },
      });
    }
  });
  return null;
}

const STEP_LABELS: Record<string, string> = {
  'branch-preflight': 'Verifying branch…',
  'contract-negotiate': 'Writing contract…',
  'mark-in-progress': 'Starting…',
  'execute-task': 'Running Claude…',
  'store-verification': 'Storing verification…',
  'post-task-check': 'Running post-task check…',
  'evaluate-task': 'Evaluating…',
  'mark-done': 'Finalizing…',
};

function labelForStep(stepName: string): string {
  return STEP_LABELS[stepName] ?? stepName;
}

export function reduceEvents(state: RunState, events: readonly HarnessEvent[]): RunState {
  const running = new Set(state.running);
  const blocked = new Set(state.blocked);
  const activity = new Map(state.activity);
  const currentStep = new Map(state.currentStep);
  let rateLimit = state.rateLimit;

  for (const event of events) {
    switch (event.type) {
      case 'task-started':
        running.add(event.taskId);
        break;
      case 'task-finished':
        running.delete(event.taskId);
        activity.delete(event.taskId);
        currentStep.delete(event.taskId);
        if (event.status === 'blocked' || event.status === 'failed') {
          blocked.add(event.taskId);
        }
        break;
      case 'task-step':
        if (event.phase === 'start') {
          activity.set(event.taskId, labelForStep(event.stepName));
          currentStep.set(event.taskId, labelForStep(event.stepName));
        } else {
          if (currentStep.get(event.taskId) === labelForStep(event.stepName)) {
            currentStep.delete(event.taskId);
          }
        }
        break;
      case 'rate-limit-paused':
        rateLimit = { pausedSince: event.timestamp, delayMs: event.delayMs };
        break;
      case 'rate-limit-resumed':
        rateLimit = null;
        break;
      case 'signal': {
        const taskId = event.ctx.taskId;
        if (taskId && event.signal.type === 'progress') {
          activity.set(taskId, event.signal.summary);
        }
        if (taskId && event.signal.type === 'task-blocked') {
          blocked.add(taskId);
        }
        break;
      }
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  return { ...state, running, blocked, activity, currentStep, rateLimit };
}
