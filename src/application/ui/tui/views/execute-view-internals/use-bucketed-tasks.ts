/** Composite derivation hook for the per-task view of an execute session. */

import { useMemo } from 'react';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { SignalBusEntry } from '@src/application/ui/tui/runtime/sinks-context.tsx';
import { useTaskRoundTracker } from '@src/application/ui/tui/runtime/use-task-round-tracker.ts';
import {
  type BucketedExecution,
  bucketTaskSignals,
  isInFlightBucket,
  type TaskBucket,
} from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

interface UseBucketedInput {
  readonly descriptor: SessionDescriptor | undefined;
  readonly chainEvents: readonly AppEvent[];
  readonly signals: readonly SignalBusEntry[];
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

/** A task the runner has finished — it sits behind the cursor. */
const isCompletedBucket = (t: TaskBucket): boolean => t.status === 'completed';

/**
 * Counters + the "what is happening right now" trio the header card reads, derived from the merged bucket.
 */
const summariseProgress = (
  bucketed: BucketedExecution | undefined,
  taskNames: ReadonlyMap<string, string> | undefined
): Omit<BucketedDerivation, 'bucketed'> => {
  const tasks = bucketed?.tasks ?? [];
  const currentTaskIdx = tasks.findIndex(isInFlightBucket);
  const currentTask = currentTaskIdx >= 0 ? tasks[currentTaskIdx] : undefined;
  const currentTaskName =
    currentTask !== undefined
      ? (taskNames?.get(currentTask.id) ?? `${currentTask.id.slice(0, 8)}${glyphs.clipEllipsis}`)
      : undefined;
  return {
    tasksDone: tasks.filter(isCompletedBucket).length,
    tasksTotal: tasks.length,
    currentTask,
    currentTaskIdx,
    currentTaskName,
    currentSubStep: currentTask?.subSteps[currentTask.subSteps.length - 1]?.leafName,
  };
};

export const useBucketedTasks = ({
  descriptor,
  chainEvents,
  signals,
  eventBus,
}: UseBucketedInput): BucketedDerivation => {
  // Stable array of known task ids — only recomputed when the task set itself changes, not on every chain-event or
  // signal flush.
  const knownTaskIds = useMemo(
    () => (descriptor?.taskNames !== undefined ? [...descriptor.taskNames.keys()] : undefined),

    [descriptor?.taskNames]
  );

  const rawBucketed = useMemo(
    () =>
      descriptor
        ? bucketTaskSignals(descriptor.trace, chainEvents, signals, {
            ...(descriptor.maxTurns !== undefined ? { maxTurns: descriptor.maxTurns } : {}),
            ...(descriptor.maxAttempts !== undefined ? { maxAttempts: descriptor.maxAttempts } : {}),
            ...(descriptor.terminalSubstepName !== undefined
              ? { terminalSubstepName: descriptor.terminalSubstepName }
              : {}),
            // taskNames carries every task the launcher knew about — surfacing the ids here makes pending rows appear
            // in the panel even when the chain failed before per-task work started (e.g. setup-script-runner abort).
            ...(knownTaskIds !== undefined ? { knownTaskIds } : {}),
          })
        : undefined,
    // Use chainEvents.length and signals.length (not the array references themselves) so this
    // memo only re-runs when events are actually added or the oldest is evicted — not on every
    // 60 ms coalescer flush that replaces the array reference with the same logical content.
    // The closure still captures the latest chainEvents / signals values at execution time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [descriptor, chainEvents.length, signals.length, knownTaskIds]
  );

  const taskRounds = useTaskRoundTracker(eventBus);

  const bucketed = useMemo(() => {
    if (rawBucketed === undefined) return undefined;
    const tasks = rawBucketed.tasks.map((t) => {
      const tracked = taskRounds.get(t.id);
      if (tracked === undefined) return t;
      const roundN = Math.max(t.genEvalRound, tracked.roundN);
      // `tracked.roundN` is a monotonic high-water ≥ the trace-derived count, so a tracked entry is always the
      // authoritative source for the attempt-relative pair.
      return {
        ...t,
        genEvalRound: roundN,
        genEvalMaxRounds: tracked.totalCap,
        attemptN: tracked.budgetedAttemptN,
        ...(tracked.resumed ? { attemptResumed: true } : {}),
        roundInAttempt: tracked.roundInAttempt,
      };
    });
    return { ...rawBucketed, tasks };
  }, [rawBucketed, taskRounds]);

  return { bucketed, ...summariseProgress(bucketed, descriptor?.taskNames) };
};
