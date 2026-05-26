/**
 * Polling hook for the baseline-health chip and card — reads the SprintExecution + Task
 * list from disk at a tight cadence while the run is live. The persisted entities are the
 * source of truth (chain leaves write to taskRepo / sprintExecutionRepo before any bus
 * event fires), so polling keeps the wiring simple at the cost of a 3s read-latency band.
 *
 * Test bootstraps wire a partial `AppDeps`; the hook guards on undefined repos so missing
 * deps in a test render don't crash the view.
 */

import React from 'react';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';

export interface BaselineHealthState {
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
}

interface UseBaselineHealthInput {
  readonly baselineSprintId: SprintId | undefined;
  readonly sprintExecutionRepo: AppDeps['sprintExecutionRepo'] | undefined;
  readonly taskRepo: AppDeps['taskRepo'] | undefined;
}

/** 3 s — fast enough for fresh VerifyRun rows; slow enough to keep disk + JSON parse cost trivial. */
const POLL_INTERVAL_MS = 3000;

export const useBaselineHealthData = ({
  baselineSprintId,
  sprintExecutionRepo,
  taskRepo,
}: UseBaselineHealthInput): BaselineHealthState => {
  const [executionState, setExecutionState] = React.useState<SprintExecution | undefined>(undefined);
  const [taskState, setTaskState] = React.useState<readonly Task[] | undefined>(undefined);

  React.useEffect(() => {
    if (baselineSprintId === undefined) {
      setExecutionState(undefined);
      setTaskState(undefined);
      return undefined;
    }
    if (sprintExecutionRepo === undefined || taskRepo === undefined) return undefined;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [execR, tasksR] = await Promise.all([
        sprintExecutionRepo.findById(baselineSprintId),
        taskRepo.findBySprintId(baselineSprintId),
      ]);
      if (cancelled) return;
      if (execR.ok) setExecutionState(execR.value);
      if (tasksR.ok) setTaskState(tasksR.value);
    };
    void load();
    const id = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baselineSprintId, sprintExecutionRepo, taskRepo]);

  return { executionState, taskState };
};
