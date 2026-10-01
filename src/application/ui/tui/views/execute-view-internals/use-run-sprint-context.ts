/**
 * Everything the Execute view derives from the run's OWN pinned sprint, in one call: the pinned-sprint context, the
 * baseline health data, and the settled next steps that read both.
 */

import { usePinnedSprintContext } from '@src/application/ui/tui/views/execute-view-internals/use-pinned-sprint-context.ts';
import { useBaselineHealthData } from '@src/application/ui/tui/views/execute-view-internals/use-baseline-health-data.ts';
import { useSettledNextSteps } from '@src/application/ui/tui/views/execute-view-internals/use-settled-next-steps.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { NextSteps } from '@src/application/ui/shared/next-steps.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { FocusedRunCtx } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

export interface UseRunSprintContextInput {
  readonly descriptor: SessionDescriptor | undefined;
  readonly pinnedSprintId: SprintId | undefined;
  readonly deps: AppDeps;
  readonly setFocusedRunContext: (ctx: FocusedRunCtx | undefined) => void;
  readonly selectionSprintId: SprintId | undefined;
  readonly followFocusedRun: (
    projectId: ProjectId,
    projectLabel: string,
    sprintId: SprintId,
    sprintLabel: string
  ) => void;
}

export interface RunSprintContext {
  /** `true` once the pin has been confirmed closed or removed — blanks the dependent panels. */
  readonly pinnedSprintStale: boolean;
  readonly executionState: SprintExecution | undefined;
  readonly taskState: readonly Task[] | undefined;
  readonly nextSteps: NextSteps;
}

export const useRunSprintContext = ({
  descriptor,
  pinnedSprintId,
  deps,
  setFocusedRunContext,
  selectionSprintId,
  followFocusedRun,
}: UseRunSprintContextInput): RunSprintContext => {
  const { pinnedSprintStale, pinnedSprint } = usePinnedSprintContext({
    pinnedProjectId: descriptor?.pinnedProjectId,
    pinnedProjectLabel: descriptor?.pinnedProjectLabel,
    pinnedSprintId,
    pinnedSprintLabel: descriptor?.pinnedSprintLabel,
    sprintRepo: deps.sprintRepo,
    setFocusedRunContext,
    selectionSprintId,
    followFocusedRun,
  });

  const { executionState, taskState } = useBaselineHealthData({
    baselineSprintId: pinnedSprintId,
    sprintExecutionRepo: deps.sprintExecutionRepo,
    taskRepo: deps.taskRepo,
  });

  const nextSteps = useSettledNextSteps({
    descriptor,
    pinnedSprint,
    pinnedSprintId,
    taskState,
    sprintRepo: deps.sprintRepo,
  });

  return { pinnedSprintStale, executionState, taskState, nextSteps };
};
