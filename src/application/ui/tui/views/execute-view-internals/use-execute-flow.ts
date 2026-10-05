/**
 * Two hook bundles the Execute view composes: the flow-progress projection (with the bucketed task
 * derivation that reads it) and the cancel-scope stats + handlers. Split out so the orchestrator
 * stays a thin wiring layer.
 */

import type React from 'react';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { FlowProgress } from '@src/application/ui/tui/runtime/flow-progress.ts';
import type { SessionDescriptor, SessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { SignalBusEntry } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { useAwaitingSessions } from '@src/application/ui/tui/runtime/use-awaiting-sessions.ts';
import { useFlowProgress } from '@src/application/ui/tui/runtime/use-flow-progress.ts';
import { useTaskRoundVerdicts } from '@src/application/ui/tui/runtime/use-task-round-verdicts.ts';
import {
  useBucketedTasks,
  type BucketedDerivation,
} from '@src/application/ui/tui/views/execute-view-internals/use-bucketed-tasks.ts';
import {
  useCancelHandlers,
  type CancelHandlers,
} from '@src/application/ui/tui/views/execute-view-internals/use-cancel-handlers.ts';
import { useCancelScopeStats } from '@src/application/ui/tui/views/execute-view-internals/use-cancel-scope-stats.ts';

interface UseExecuteCancelInput {
  readonly sessions: SessionManager;
  readonly sessionId: string;
  readonly deps: AppDeps;
  readonly chainEvents: readonly AppEvent[];
  readonly bucketedTasks: BucketedDerivation;
  readonly sprintId: SprintId | undefined;
  readonly setCancelScopeOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Cancel-scope stats + the cancel handlers, which read the same current task and event buffer. */
export const useExecuteCancel = ({
  sessions,
  sessionId,
  deps,
  chainEvents,
  bucketedTasks,
  sprintId,
  setCancelScopeOpen,
}: UseExecuteCancelInput): {
  readonly stats: ReturnType<typeof useCancelScopeStats>;
  readonly handlers: CancelHandlers;
} => {
  const { currentTask, bucketed } = bucketedTasks;
  const stats = useCancelScopeStats({ chainEvents, currentTask, bucketed });
  const handlers = useCancelHandlers({
    sessions,
    sessionId,
    sprintId,
    currentTask,
    taskRepo: deps.taskRepo,
    logger: deps.logger,
    setCancelScopeOpen,
  });
  return { stats, handlers };
};

/** Flow-progress inputs the Frame also needs: who is awaiting an answer, and the one shared projection. */
export interface FlowState {
  readonly awaiting: ReadonlyMap<string, number>;
  readonly progress: FlowProgress | undefined;
}

/** One projection feeds the header strip, every Steps tree and the per-task trees. */
export const useExecuteProgress = (
  descriptor: SessionDescriptor | undefined,
  sessionId: string,
  eventBus: AppDeps['eventBus'],
  chainEvents: readonly AppEvent[],
  signals: readonly SignalBusEntry[]
): { readonly flow: FlowState; readonly bucketedTasks: BucketedDerivation } => {
  const awaiting = useAwaitingSessions();
  const verdicts = useTaskRoundVerdicts(eventBus);
  const awaitingNow = descriptor?.status === 'running' && awaiting.has(sessionId);
  const progress = useFlowProgress({ descriptor, awaiting: awaitingNow, verdicts });
  const bucketedTasks = useBucketedTasks({ descriptor, chainEvents, signals, eventBus, progress });
  return { flow: { awaiting, progress }, bucketedTasks };
};
