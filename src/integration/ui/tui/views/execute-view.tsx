/**
 * ExecuteView — live dashboard for `sprint start`.
 *
 * Renders the sprint header, a task grid, a log tail, and a rate-limit
 * banner; subscribes to `SignalBusPort` + `logEventBus` and re-renders on
 * every event. Kicks off `ExecuteTasksUseCase` in a mount-time effect.
 *
 * Navigation is handled by the surrounding `<ViewRouter />`:
 *   - `s` opens settings (router pushes settings on top)
 *   - `Esc` pops back if Execute was pushed; no-op when Execute is the root
 *   - `h` resets the stack to Home
 *
 * When execution finishes, ExecuteView replaces itself with Home so the user
 * lands on the menu (matching the SPA model — no app exit).
 *
 * Settings edits flow through `PersistencePort.saveConfig()` and the next
 * task picked up from the queue reads fresh config (REQ-12).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HarnessEvent } from '@src/business/ports/signal-bus.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import { getPrompt, getSharedDeps } from '@src/integration/bootstrap.ts';
import { createExecuteSprintPipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipelines/framework/pipeline.ts';
import { areAllTasksDone } from '@src/integration/persistence/task.ts';
import { closeSprint } from '@src/integration/persistence/sprint.ts';
import { useLoggerEvents, useSignalEvents } from '@src/integration/ui/tui/runtime/hooks.ts';
import { TaskGrid } from '@src/integration/ui/tui/components/task-grid.tsx';
import { SprintSummary } from '@src/integration/ui/tui/components/sprint-summary.tsx';
import { LogTail } from '@src/integration/ui/tui/components/log-tail.tsx';
import { RateLimitBanner } from '@src/integration/ui/tui/components/rate-limit-banner.tsx';
import { useRouter } from './router-context.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import type { ExecutionSummary } from '@src/business/usecases/execute.ts';

const EXECUTE_HINTS_RUNNING = [] as const;
const EXECUTE_HINTS_DONE = [{ key: 'Enter', action: 'home' }] as const;

interface Props {
  sprintId: string;
  executionOptions?: ExecutionOptions;
}

interface RunState {
  sprint: Sprint | null;
  tasks: readonly Task[];
  running: Set<string>;
  blocked: Set<string>;
  activity: Map<string, string>;
  summary: ExecutionSummary | null;
  error: string | null;
  rateLimit: { pausedSince: Date; delayMs: number } | null;
}

export function initialState(): RunState {
  return {
    sprint: null,
    tasks: [],
    running: new Set(),
    blocked: new Set(),
    activity: new Map(),
    summary: null,
    error: null,
    rateLimit: null,
  };
}

export function ExecuteView({ sprintId, executionOptions }: Props): React.JSX.Element {
  const router = useRouter();
  const shared = getSharedDeps();
  const signalEvents = useSignalEvents(shared.signalBus);
  const logEvents = useLoggerEvents(200);

  const [state, setState] = useState(initialState);
  const [done, setDone] = useState(false);
  const processedCountRef = useRef(0);

  // Load sprint + tasks once for the initial grid. Subsequent refreshes happen
  // on task-finished events (which update the in-memory view only — the
  // authoritative source remains the filesystem, and we re-read on finish).
  useEffect(() => {
    const cancel = { current: false };
    const load = async (): Promise<void> => {
      try {
        const [sprint, tasks] = await Promise.all([
          shared.persistence.getSprint(sprintId),
          shared.persistence.getTasks(sprintId),
        ]);
        if (!cancel.current) setState((s) => ({ ...s, sprint, tasks }));
      } catch (err) {
        if (!cancel.current) setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      }
    };
    void load();
    return () => {
      cancel.current = true;
    };
  }, [shared, sprintId]);

  // Kick off execution once the sprint is loaded.
  useEffect(() => {
    if (state.sprint === null || done) return;
    const cancel = { current: false };
    const run = async (): Promise<void> => {
      try {
        const pipeline = createExecuteSprintPipeline(shared, executionOptions);
        const result = await executePipeline(pipeline, { sprintId });
        if (cancel.current) return;
        if (result.ok) {
          const summary = result.value.context.executionSummary ?? null;
          setState((s) => ({ ...s, summary }));
        } else {
          setState((s) => ({ ...s, error: result.error.message }));
        }
      } catch (err) {
        if (!cancel.current) setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        if (!cancel.current) setDone(true);
      }
    };
    void run();
    return () => {
      cancel.current = true;
    };
    // We intentionally only want to start execution once per sprint load.
  }, [state.sprint, shared, sprintId, executionOptions, done]);

  // Reduce only the new events — the buffer is rolling, so we track the
  // length already consumed in a ref. React state holds the reduced view.
  useEffect(() => {
    if (signalEvents.length <= processedCountRef.current) return;
    const fresh = signalEvents.slice(processedCountRef.current);
    processedCountRef.current = signalEvents.length;
    setState((prev) => reduceEvents(prev, fresh));
  }, [signalEvents]);

  const [closePromptRun, setClosePromptRun] = useState(false);

  // Re-fetch tasks once execution finishes so the final grid reflects
  // statuses persisted by the executor; then, for a fully-completed sprint,
  // prompt the user whether to close it (REQ-13 parity with the plain-text
  // path in sprintStartCommand).
  useEffect(() => {
    if (!done) return;
    void (async () => {
      try {
        const tasks = await shared.persistence.getTasks(sprintId);
        setState((s) => ({ ...s, tasks }));
      } catch {
        // Leave the in-memory view as-is; the summary still renders.
      }

      if (closePromptRun) return;
      setClosePromptRun(true);

      const summary = state.summary;
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
  }, [done, shared, sprintId, state.summary, closePromptRun]);

  // Once execution finishes, any key (other than the global router hotkeys)
  // returns to home. Esc / h / s are handled by the router and short-circuit
  // before this fires.
  useInput((input, key) => {
    if (!done) return;
    if (key.escape || input === 'h' || input === 's' || input === 'q') return;
    if (key.return || input.length > 0) {
      router.replace({ id: 'home' });
    }
  });

  useViewHints(done ? EXECUTE_HINTS_DONE : EXECUTE_HINTS_RUNNING);

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

      <Box marginTop={spacing.section}>
        <LogTail events={logEvents} />
      </Box>

      {state.error ? (
        <Box marginTop={spacing.section}>
          <Text color={inkColors.error}>
            {glyphs.cross} {state.error}
          </Text>
        </Box>
      ) : null}

      {state.summary && done ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <Text color={inkColors.success} bold>
            {glyphs.check} Execution finished
          </Text>
          <Text dimColor>
            {state.summary.completed} completed {glyphs.inlineDot} {state.summary.remaining} remaining{' '}
            {glyphs.inlineDot} {state.summary.blocked} blocked
            {'  ('}
            {state.summary.stopReason}
            {')'}
          </Text>
          <Box marginTop={spacing.section}>
            <Text dimColor>Press any key to return home.</Text>
          </Box>
        </Box>
      ) : null}
    </ViewShell>
  );
}

export function reduceEvents(state: RunState, events: readonly HarnessEvent[]): RunState {
  const running = new Set(state.running);
  const blocked = new Set(state.blocked);
  const activity = new Map(state.activity);
  let rateLimit = state.rateLimit;

  for (const event of events) {
    switch (event.type) {
      case 'task-started':
        running.add(event.taskId);
        break;
      case 'task-finished':
        running.delete(event.taskId);
        if (event.status === 'blocked' || event.status === 'failed') {
          blocked.add(event.taskId);
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

  return { ...state, running, blocked, activity, rateLimit };
}
