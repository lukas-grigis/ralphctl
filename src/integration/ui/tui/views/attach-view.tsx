/**
 * AttachView — read-only live view of a sprint daemon running in another
 * process. Renders the same DAG + running-task surface as the foreground
 * execute view, but data is sourced from disk (runs-store, tasks.json,
 * daemon log file) since the in-memory `ExecutionRegistryPort` is empty in
 * this process.
 *
 * Polling cadence:
 *   - tasks.json polled every 1 s for status transitions
 *   - runs-store state.json polled every 1 s for terminal status
 *   - log file is `fs.watch`-ed for appended lines (replayed on attach)
 *
 * Pressing Esc / Enter on a terminal run pops back to the previous frame.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Sprint, Task } from '@src/domain/models.ts';
import { getSharedDeps } from '@src/integration/bootstrap.ts';
import { readRun, type RunState } from '@src/integration/runtime/runs-store.ts';
import { tailLogFile, type TailHandle } from '@src/integration/runtime/log-file-tail.ts';
import { ResultCard } from '@src/integration/ui/tui/components/result-card.tsx';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';
import { ViewShell } from '@src/integration/ui/tui/components/view-shell.tsx';
import { SprintSummary } from '@src/integration/ui/tui/components/sprint-summary.tsx';
import { DagView } from '@src/integration/ui/tui/components/dag-view.tsx';
import { useViewHints } from '@src/integration/ui/tui/views/view-hints-context.tsx';
import { useRouter } from '@src/integration/ui/tui/views/router-context.ts';
import { formatElapsed } from '@src/integration/ui/tui/components/elapsed.ts';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';

interface Props {
  readonly executionId: string;
}

const HINTS_RUNNING = [{ key: 'Esc', action: 'detach' }] as const;
const HINTS_TERMINAL = [{ key: 'Enter', action: 'back' }] as const;

const POLL_INTERVAL_MS = 1000;
const RUNNING_TASK_TICK_MS = 1000;
const LOG_TAIL_MAX_LINES = 12;

interface AttachState {
  readonly run: RunState | null;
  readonly sprint: Sprint | null;
  readonly tasks: readonly Task[];
  /** Map taskId → ISO timestamp of when we first noticed the task in `in_progress`. */
  readonly runningSince: ReadonlyMap<string, number>;
  readonly loadError: string | null;
}

const INITIAL: AttachState = {
  run: null,
  sprint: null,
  tasks: [],
  runningSince: new Map<string, number>(),
  loadError: null,
};

export function AttachView({ executionId }: Props): React.JSX.Element {
  const router = useRouter();
  const shared = getSharedDeps();
  const [state, setState] = useState<AttachState>(INITIAL);
  const [logLines, setLogLines] = useState<readonly string[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const { stdout } = useStdout();

  // Refresh tasks + run state from disk on a tick. Mutating sets are kept
  // referentially stable when no underlying change occurred so React skips
  // unnecessary re-renders.
  useEffect(() => {
    let cancelled = false;
    const reload = async (): Promise<void> => {
      try {
        const run = await readRun(executionId);
        if (cancelled) return;
        if (!run) {
          setState((s) => ({ ...s, loadError: `Execution ${executionId} not found in runs-store.` }));
          return;
        }
        const sprint = await shared.persistence.getSprint(run.sprintId);
        const tasks = await shared.persistence.getTasks(run.sprintId);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cancelled) return;
        setState((prev) => {
          const nextRunningSince = new Map(prev.runningSince);
          const seen = new Set<string>();
          for (const task of tasks) {
            if (task.status === 'in_progress') {
              seen.add(task.id);
              if (!nextRunningSince.has(task.id)) {
                nextRunningSince.set(task.id, Date.now());
              }
            }
          }
          for (const id of nextRunningSince.keys()) {
            if (!seen.has(id)) nextRunningSince.delete(id);
          }
          return { ...prev, run, sprint, tasks, runningSince: nextRunningSince, loadError: null };
        });
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({ ...s, loadError: err instanceof Error ? err.message : String(err) }));
      }
    };
    void reload();
    const interval = setInterval(() => {
      void reload();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [executionId, shared]);

  // Tick `now` so elapsed-time labels for running tasks update live without
  // waiting for the next poll cycle.
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, RUNNING_TASK_TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, []);

  // Tail the log file. We read the path lazily once `state.run.logPath` is
  // populated since the daemon writes the path on first state.json update.
  const logPath = state.run?.logPath ?? null;
  useEffect(() => {
    if (logPath === null) return;
    let handle: TailHandle | null = null;
    let cancelled = false;
    void (async () => {
      try {
        handle = await tailLogFile({
          path: logPath,
          onLine: (line) => {
            if (cancelled) return;
            setLogLines((prev) => {
              const next = [...prev, line];
              if (next.length > LOG_TAIL_MAX_LINES * 4) {
                return next.slice(-LOG_TAIL_MAX_LINES * 4);
              }
              return next;
            });
          },
          onError: () => {
            // File may not exist yet — silent retry on next poll cycle.
          },
        });
      } catch {
        // Tail attach failed — fall through; user still sees DAG state.
      }
    })();
    return () => {
      cancelled = true;
      if (handle) void handle.close();
    };
  }, [logPath]);

  const status: RunState['status'] = state.run?.status ?? 'running';
  const terminal = status !== 'running';

  const runningTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of state.tasks) {
      if (t.status === 'in_progress') ids.add(t.id);
    }
    return ids;
  }, [state.tasks]);

  const failedTaskIds = useMemo(() => new Set<string>(), []);
  const blockedTaskIds = useMemo(() => new Set<string>(), []);

  useViewHints(terminal ? HINTS_TERMINAL : HINTS_RUNNING);

  useInput((_input, key) => {
    if (terminal && key.return) {
      router.pop();
    }
  });

  if (state.loadError !== null) {
    return (
      <ViewShell title="Attach">
        <ResultCard
          kind="error"
          title="Could not attach to execution"
          lines={[state.loadError]}
          nextSteps={[
            { action: 'Press Esc to go back', description: 'Run sprint list-runs to see available daemons.' },
          ]}
        />
      </ViewShell>
    );
  }

  if (state.run === null) {
    return (
      <ViewShell title="Attach">
        <Spinner label="Reading run state…" />
      </ViewShell>
    );
  }

  const tailLog = logLines.slice(-LOG_TAIL_MAX_LINES);
  const terminalWidth = stdout.columns;

  const runningRows = state.tasks
    .filter((t) => runningTaskIds.has(t.id))
    .map((t) => {
      const startedAt = state.runningSince.get(t.id) ?? now;
      const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));
      return { task: t, elapsedSec };
    });

  return (
    <ViewShell title="Attach">
      <Box>
        <Text bold color={inkColors.primary}>
          {state.sprint?.name ?? state.run.sprintId}
        </Text>
        <Text dimColor>
          {'  '}
          {state.run.status === 'running' ? '(daemon running)' : `(daemon ${state.run.status})`}
          {'  '}
          {`pid ${String(state.run.pid)}`}
        </Text>
      </Box>

      <Box marginTop={spacing.section}>
        <SprintSummary tasks={state.tasks} />
      </Box>

      <Box marginTop={spacing.section} flexDirection="column">
        <DagView
          tasks={state.tasks}
          runningTaskIds={runningTaskIds}
          failedTaskIds={failedTaskIds}
          blockedTaskIds={blockedTaskIds}
          terminalWidth={terminalWidth}
        />
      </Box>

      {runningRows.length > 0 ? (
        <Box marginTop={spacing.section} flexDirection="column">
          <Text dimColor>── Running ────────────────────────</Text>
          {runningRows.map(({ task, elapsedSec }) => (
            <Box key={task.id}>
              <Spinner label={`${task.name}  (${formatElapsed(elapsedSec)})`} color={inkColors.warning} />
            </Box>
          ))}
        </Box>
      ) : null}

      <Box marginTop={spacing.section} flexDirection="column">
        <Text dimColor>── Log ────────────────────────────</Text>
        {tailLog.length === 0 ? (
          <Text dimColor>(waiting for output)</Text>
        ) : (
          tailLog.map((line, idx) => (
            <Text key={idx} dimColor={line.length === 0}>
              {line.length === 0 ? ' ' : line}
            </Text>
          ))
        )}
      </Box>

      {terminal ? (
        <Box marginTop={spacing.section}>
          <Text color={status === 'completed' ? inkColors.success : inkColors.error} bold>
            {status === 'completed' ? glyphs.check : glyphs.cross} Daemon {status}
          </Text>
        </Box>
      ) : null}
    </ViewShell>
  );
}
