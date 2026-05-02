/**
 * DashboardView — full-screen status destination.
 *
 * Layout top-to-bottom:
 *   1. Hero — sprint name, status chip, ticket count, task progress, branch
 *   2. Task grid — one row per task with status, name, project-path tail
 *   3. Blockers — tasks with status === 'blocked' (hidden when none)
 *   4. Log tail — rolling recent events
 *
 * Data source: `currentSprint` from config → `sprintRepo.findById` +
 * `taskRepo.findBySprintId`. Re-fetches on mount and whenever the
 * SessionManager emits a `task-finished`-equivalent event (session removed /
 * status-changed), so the grid stays fresh after execution.
 *
 * `d` from anywhere navigates here. `Esc` pops back.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import { ViewShell } from '@src/application/tui/components/view-shell.tsx';
import { FieldList } from '@src/application/tui/components/field-list.tsx';
import { ResultCard } from '@src/application/tui/components/result-card.tsx';
import { Spinner } from '@src/application/tui/components/spinner.tsx';
import {
  StatusChip,
  chipKindForSprintStatus,
  chipKindForTaskStatus,
} from '@src/application/tui/components/status-chip.tsx';
import { useViewHints } from './view-hints-context.tsx';
import { useLoggerEvents, useSessionEvents } from '@src/application/tui/runtime/hooks.ts';
import { getSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { ShowSprintUseCase } from '@src/business/usecases/sprint/show-sprint.ts';
import { ListTasksUseCase } from '@src/business/usecases/task/list-tasks.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { SessionManagerPort } from '@src/application/runtime/session-manager-port.ts';

const DASHBOARD_HINTS = [{ key: 'Esc', action: 'back' }] as const;

/** Last two path segments, e.g. `/org/repo`. */
function pathTail(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (parts.length >= 2 && secondLast !== undefined && last !== undefined) return `${secondLast}/${last}`;
  return last ?? p;
}

interface HeroProps {
  readonly sprint: Sprint;
  readonly tasks: readonly Task[];
}

function Hero({ sprint, tasks }: HeroProps): React.JSX.Element {
  const done = tasks.filter((t) => t.status === 'done').length;
  const fields: [string, string][] = [
    ['Tickets', String(sprint.tickets.length)],
    ['Tasks', `${String(done)} of ${String(tasks.length)} done`],
    ['Branch', sprint.branch ?? '—'],
  ];
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{sprint.name}</Text>
        <Box marginLeft={spacing.indent}>
          <StatusChip label={sprint.status} kind={chipKindForSprintStatus(sprint.status)} />
        </Box>
        <Text dimColor>{`  ${glyphs.inlineDot} ${String(sprint.id)}`}</Text>
      </Box>
      <Box marginTop={0}>
        <FieldList fields={fields} />
      </Box>
    </Box>
  );
}

interface TaskGridProps {
  readonly tasks: readonly Task[];
}

function TaskGrid({ tasks }: TaskGridProps): React.JSX.Element {
  if (tasks.length === 0) {
    return <Text dimColor>No tasks in this sprint.</Text>;
  }
  return (
    <Box flexDirection="column">
      {tasks.map((task) => (
        <Box key={String(task.id)}>
          <TaskStatusGlyph status={task.status} />
          <Text>{`  ${String(task.order).padStart(2)}. `}</Text>
          <Text>{task.name}</Text>
          <Text dimColor>{`  ${glyphs.inlineDot} ${pathTail(String(task.projectPath))}`}</Text>
          <Text>{`  `}</Text>
          <StatusChip label={task.status.replace('_', ' ')} kind={chipKindForTaskStatus(task.status)} />
        </Box>
      ))}
    </Box>
  );
}

function TaskStatusGlyph({ status }: { readonly status: Task['status'] }): React.JSX.Element {
  if (status === 'done') return <Text color={inkColors.success}>{glyphs.phaseDone}</Text>;
  if (status === 'in_progress') return <Text color={inkColors.warning}>{glyphs.phaseActive}</Text>;
  if (status === 'blocked') return <Text color={inkColors.error}>{glyphs.cross}</Text>;
  return <Text color={inkColors.muted}>{glyphs.phasePending}</Text>;
}

interface BlockersProps {
  readonly tasks: readonly Task[];
}

function Blockers({ tasks }: BlockersProps): React.JSX.Element | null {
  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={spacing.section}>
      <Text color={inkColors.error} bold>
        {glyphs.warningGlyph} Blocked tasks
      </Text>
      {blocked.map((task) => (
        <Box key={String(task.id)} paddingLeft={spacing.indent} marginTop={0}>
          <Text color={inkColors.error}>{glyphs.cross} </Text>
          <Text bold>{task.name}</Text>
          <Text dimColor>{`  ${glyphs.inlineDot} ${pathTail(String(task.projectPath))}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

interface Props {
  readonly sessionManager?: SessionManagerPort | null;
}

export function DashboardView({ sessionManager }: Props): React.JSX.Element {
  useViewHints(DASHBOARD_HINTS);
  const logs = useLoggerEvents(50);
  // Subscribe so we re-fetch when sessions finish
  useSessionEvents(sessionManager ?? null);

  const [sprint, setSprint] = useState<Sprint | null>(null);
  const [tasks, setTasks] = useState<readonly Task[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback((): (() => void) => {
    setLoadError(null);
    const cancel = { current: false };
    void (async () => {
      try {
        const deps = await getSharedDeps();
        const cfgResult = await deps.configStore.load();
        if (!cfgResult.ok) return;
        const sprintIdStr = cfgResult.value.currentSprint;
        if (!sprintIdStr) {
          setSprint(null);
          setTasks([]);
          return;
        }
        const idResult = SprintId.parse(sprintIdStr);
        if (!idResult.ok) {
          setLoadError(idResult.error.message);
          return;
        }
        const showUC = new ShowSprintUseCase(deps.sprintRepo);
        const sprintResult = await showUC.execute({ id: idResult.value });
        if (cancel.current) return;
        if (!sprintResult.ok) {
          setLoadError(sprintResult.error.message);
          return;
        }
        setSprint(sprintResult.value);
        const listUC = new ListTasksUseCase(deps.taskRepo);
        const tasksResult = await listUC.execute({ sprintId: idResult.value });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (cancel.current) return;
        if (!tasksResult.ok) {
          setLoadError(tasksResult.error.message);
          return;
        }
        const sorted = [...tasksResult.value].sort((a, b) => a.order - b.order);
        setTasks(sorted);
      } catch (err) {
        if (!cancel.current) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  // Re-fetch whenever the session registry changes (task-finished proxy).
  // Each `load()` call returns a cancel handle for its in-flight async
  // work. We chain them: before kicking off a new load, cancel the
  // previous one so a slow earlier fetch can't write stale state on
  // top of a fresh one (a real race when many tasks settle in quick
  // succession on the same sprint).
  useEffect(() => {
    if (!sessionManager) return;
    let cancelLast: (() => void) | null = null;
    const unsub = sessionManager.subscribe(() => {
      cancelLast?.();
      cancelLast = load();
    });
    return () => {
      cancelLast?.();
      unsub();
    };
  }, [sessionManager, load]);

  return (
    <ViewShell title="DASHBOARD">
      <Box flexDirection="column">
        {/* ── Hero ──────────────────────────────────────────────────── */}
        {loadError !== null ? (
          <ResultCard kind="error" title="Failed to load sprint data" lines={[loadError]} />
        ) : sprint === null && tasks === null ? (
          <Spinner label="Loading…" />
        ) : sprint === null ? (
          <ResultCard
            kind="info"
            title="No active sprint"
            nextSteps={[{ action: 'Create a sprint', description: "press 'h'" }]}
          />
        ) : (
          <>
            <Hero sprint={sprint} tasks={tasks ?? []} />

            {/* ── Task grid ────────────────────────────────────────── */}
            <Box marginTop={spacing.section} flexDirection="column">
              <Text dimColor bold>
                Tasks
              </Text>
              <Box marginTop={0}>
                <TaskGrid tasks={tasks ?? []} />
              </Box>
            </Box>

            {/* ── Blockers ─────────────────────────────────────────── */}
            <Blockers tasks={tasks ?? []} />
          </>
        )}

        {/* ── Log tail ─────────────────────────────────────────────── */}
        {logs.length > 0 ? (
          <Box flexDirection="column" marginTop={spacing.section}>
            <Text dimColor bold>
              Recent events
            </Text>
            {logs.slice(-12).map((event, i) => (
              <Box key={i}>
                <Text color={inkColors.muted} dimColor>
                  {String(event.timestamp).slice(11, 19)}{' '}
                </Text>
                <StatusChip
                  label={event.level}
                  kind={
                    event.level === 'error'
                      ? 'error'
                      : event.level === 'warn'
                        ? 'warning'
                        : event.level === 'success'
                          ? 'success'
                          : event.level === 'info'
                            ? 'info'
                            : 'muted'
                  }
                />
                <Text>{` ${event.message}`}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
    </ViewShell>
  );
}
