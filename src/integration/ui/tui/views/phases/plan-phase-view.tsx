/**
 * PlanPhaseView — detail screen for the Plan phase.
 *
 * Lists the current sprint's generated tasks grouped by project path, shows
 * ticket coverage (how many tickets have tasks), and offers a "Plan" /
 * "Re-Plan" action button on draft sprints with approved requirements.
 *
 * Static for this commit — Commit C subscribes to the session-stream bus to
 * surface live AI exploration output while the plan pipeline is running.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Sprint, Tasks } from '@src/domain/models.ts';
import type { StepExecutionRecord } from '@src/business/pipeline/types.ts';
import { getSharedDeps } from '@src/application/bootstrap.ts';
import { createPlanPipeline } from '@src/application/factories.ts';
import { executePipeline } from '@src/business/pipeline/pipeline.ts';
import { inkColors } from '@src/integration/ui/tui/theme/tokens.ts';
import { PhaseRunTrace } from './phase-run-trace.tsx';

interface Props {
  readonly sprintId: string;
}

interface State {
  sprint: Sprint | null;
  tasks: Tasks;
  records: readonly StepExecutionRecord[];
  running: boolean;
  error: string | null;
}

function initialState(): State {
  return { sprint: null, tasks: [], records: [], running: false, error: null };
}

export function PlanPhaseView({ sprintId }: Props): React.JSX.Element {
  const shared = getSharedDeps();
  const [state, setState] = useState<State>(initialState);

  const loadSprintAndTasks = useCallback(async (): Promise<void> => {
    try {
      const [sprint, tasks] = await Promise.all([
        shared.persistence.getSprint(sprintId),
        shared.persistence.getTasks(sprintId),
      ]);
      setState((s) => ({ ...s, sprint, tasks, error: null }));
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [shared, sprintId]);

  useEffect(() => {
    void loadSprintAndTasks();
  }, [loadSprintAndTasks]);

  const runPlan = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, running: true, error: null, records: [] }));
    try {
      const pipeline = createPlanPipeline(shared);
      const result = await executePipeline(pipeline, { sprintId });
      if (result.ok) {
        setState((s) => ({ ...s, records: result.value.stepResults }));
      } else {
        setState((s) => ({ ...s, error: result.error.message }));
      }
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setState((s) => ({ ...s, running: false }));
      await loadSprintAndTasks();
    }
  }, [shared, sprintId, loadSprintAndTasks]);

  useInput(
    (_input, key) => {
      if (key.return && !state.running && canPlan(state.sprint)) {
        void runPlan();
      }
    },
    { isActive: !state.running }
  );

  if (state.sprint === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{state.error ?? 'Loading sprint…'}</Text>
      </Box>
    );
  }

  const sprint = state.sprint;
  const tasks = state.tasks;
  const plannedTickets = countPlannedTickets(sprint, tasks);
  const tasksByPath = groupTasksByPath(tasks);
  const planAvailable = canPlan(sprint);
  const actionLabel = tasks.length === 0 ? 'Plan Tasks' : 'Re-Plan Tasks';

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={inkColors.primary}>
          Plan — {sprint.name}
        </Text>
        <Text dimColor>{`  (${sprint.status})`}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {`${String(plannedTickets)}/${String(sprint.tickets.length)} tickets planned  ·  ${String(tasks.length)} task${tasks.length !== 1 ? 's' : ''}`}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>
          Tasks by project
        </Text>
        {tasks.length === 0 ? (
          <Box paddingLeft={2}>
            <Text dimColor>(no tasks yet)</Text>
          </Box>
        ) : (
          Array.from(tasksByPath.entries()).map(([path, group]) => (
            <Box key={path} flexDirection="column" paddingLeft={2} marginTop={1}>
              <Text dimColor bold>
                {path}
              </Text>
              {group.map((t) => (
                <Box key={t.id} paddingLeft={2}>
                  <Text color={statusColor(t.status)} bold>
                    {statusGlyph(t.status)}
                  </Text>
                  <Text>{` ${t.name}`}</Text>
                </Box>
              ))}
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        {state.running ? (
          <Text color={inkColors.warning} bold>
            ⋯ Running plan pipeline…
          </Text>
        ) : planAvailable ? (
          <Text color={inkColors.highlight} bold>
            ▶ Press Enter to {actionLabel.toLowerCase()}
          </Text>
        ) : (
          <Text dimColor>{reasonUnavailable(sprint)}</Text>
        )}
      </Box>

      {state.error ? (
        <Box marginTop={1}>
          <Text color={inkColors.error}>✗ {state.error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <PhaseRunTrace records={state.records} title="Last plan run" />
      </Box>
    </Box>
  );
}

function canPlan(sprint: Sprint | null): boolean {
  if (sprint === null) return false;
  if (sprint.status !== 'draft') return false;
  if (sprint.tickets.length === 0) return false;
  return sprint.tickets.every((t) => t.requirementStatus === 'approved');
}

function reasonUnavailable(sprint: Sprint): string {
  if (sprint.status !== 'draft') return `Plan requires a draft sprint (this one is ${sprint.status}).`;
  if (sprint.tickets.length === 0) return 'Add at least one ticket before planning.';
  return 'All tickets must be refined before planning.';
}

function countPlannedTickets(sprint: Sprint, tasks: Tasks): number {
  const ticketIds = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
  return sprint.tickets.filter((t) => ticketIds.has(t.id)).length;
}

function groupTasksByPath(tasks: Tasks): Map<string, Tasks> {
  const map = new Map<string, Tasks>();
  for (const task of tasks) {
    const list = map.get(task.projectPath) ?? [];
    list.push(task);
    map.set(task.projectPath, list);
  }
  return map;
}

function statusGlyph(status: 'todo' | 'in_progress' | 'done'): string {
  if (status === 'done') return '✓';
  if (status === 'in_progress') return '▸';
  return '·';
}

function statusColor(status: 'todo' | 'in_progress' | 'done'): string {
  if (status === 'done') return inkColors.success;
  if (status === 'in_progress') return inkColors.warning;
  return inkColors.muted;
}
