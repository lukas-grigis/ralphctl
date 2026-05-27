/**
 * Composite derivation hook for the per-task view of an execute session. Runs
 * `bucketTaskSignals` over the descriptor's trace + chain events + harness signal stream,
 * then overlays the authoritative round counter from `useTaskRoundTracker`.
 *
 * Why the round overlay matters: the chain trace is a ring buffer (see
 * `MAX_TRACE_ENTRIES` in `runner.ts`). Counting `generator-<taskId>` entries silently
 * undercounts once early ones get evicted. The round tracker holds a monotonic high-water
 * keyed by task id sourced from `task-round-started` events, so the merged bucket's
 * `genEvalRound` only ever moves forward — even after a long-running task has spilled its
 * generator entries out of the ring.
 *
 * `latest-event-wins, but never regress` — if the tracker is empty (e.g. a post-mortem
 * view of an aborted runner with no incoming events) the bucketed value derived from the
 * descriptor's frozen trace wins, so a freshly-reloaded session still reads correctly.
 */

import { useMemo } from 'react';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { useTaskRoundTracker } from '@src/application/ui/tui/runtime/use-task-round-tracker.ts';
import {
  bucketTaskSignals,
  type BucketedExecution,
  type TaskBucket,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

interface UseBucketedInput {
  readonly descriptor: SessionDescriptor | undefined;
  readonly chainEvents: readonly AppEvent[];
  readonly signals: readonly HarnessSignal[];
  readonly eventBus: EventBus;
}

export interface BucketedDerivation {
  readonly bucketed: BucketedExecution | undefined;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly currentTask: TaskBucket | undefined;
  readonly currentTaskIdx: number;
  readonly currentTaskName: string | undefined;
  readonly currentSubStep: string | undefined;
}

export const useBucketedTasks = ({
  descriptor,
  chainEvents,
  signals,
  eventBus,
}: UseBucketedInput): BucketedDerivation => {
  const rawBucketed = useMemo(
    () =>
      descriptor
        ? bucketTaskSignals(descriptor.trace, chainEvents, signals, {
            ...(descriptor.maxTurns !== undefined ? { maxTurns: descriptor.maxTurns } : {}),
            ...(descriptor.terminalSubstepName !== undefined
              ? { terminalSubstepName: descriptor.terminalSubstepName }
              : {}),
            // taskNames carries every task the launcher knew about — surfacing the ids here
            // makes pending rows appear in the panel even when the chain failed before per-task
            // work started (e.g. setup-script-runner abort). Without this, a sprint with real
            // tasks renders the misleading "panel empty · Run plan" empty state.
            ...(descriptor.taskNames !== undefined ? { knownTaskIds: [...descriptor.taskNames.keys()] } : {}),
          })
        : undefined,
    [descriptor, chainEvents, signals]
  );

  const taskRounds = useTaskRoundTracker(eventBus);

  const bucketed = useMemo(() => {
    if (rawBucketed === undefined) return undefined;
    const tasks = rawBucketed.tasks.map((t) => {
      const tracked = taskRounds.get(t.id);
      if (tracked === undefined) return t;
      const roundN = Math.max(t.genEvalRound, tracked.roundN);
      return {
        ...t,
        genEvalRound: roundN,
        genEvalMaxRounds: tracked.totalCap,
      };
    });
    return { ...rawBucketed, tasks };
  }, [rawBucketed, taskRounds]);

  const tasksDone = bucketed?.tasks.filter((t) => t.status === 'completed').length ?? 0;
  const tasksTotal = bucketed?.tasks.length ?? 0;

  // Current task = the first non-completed one — which is `running` mid-task and `pending` in
  // the brief transition window between tasks. Completed/failed/aborted/skipped tasks are
  // behind the cursor; the per-task chain runs sequentially so the first non-completed task
  // is always the one in flight.
  const currentTaskIdx = bucketed?.tasks.findIndex((t) => t.status !== 'completed') ?? -1;
  const currentTask = currentTaskIdx >= 0 ? bucketed?.tasks[currentTaskIdx] : undefined;
  const currentTaskName =
    currentTask !== undefined
      ? (descriptor?.taskNames?.get(currentTask.id) ?? `${currentTask.id.slice(0, 8)}${glyphs.clipEllipsis}`)
      : undefined;
  const currentSubStep = currentTask?.subSteps[currentTask.subSteps.length - 1]?.leafName;

  return {
    bucketed,
    tasksDone,
    tasksTotal,
    currentTask,
    currentTaskIdx,
    currentTaskName,
    currentSubStep,
  };
};
