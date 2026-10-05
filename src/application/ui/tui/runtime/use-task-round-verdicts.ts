/**
 * Per-round evaluator verdicts — folds `task-round-evaluated` events into
 * `taskId → attemptN → roundN → verdict`. The event carries `taskId`, so attribution is exact and
 * never goes through the bucketed signal stream. Retention mirrors `use-task-round-tracker.ts`:
 * one entry per task, LRU-capped at {@link TASK_VERDICT_CAP}, coalesced into one commit per window.
 */

import type { AppEvent, TaskRoundEvaluatedEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { useCoalescedMap } from '@src/application/ui/tui/runtime/use-coalesced-map.ts';
import type { RoundVerdict, RoundVerdictLookup } from '@src/application/ui/tui/runtime/flow-progress.ts';

export const TASK_VERDICT_CAP = 500;

/** attemptN → roundN → verdict, for one task. */
export type TaskVerdicts = ReadonlyMap<number, ReadonlyMap<number, RoundVerdict>>;

const isRoundEvaluated = (e: AppEvent): e is TaskRoundEvaluatedEvent => e.type === 'task-round-evaluated';
const keyOfVerdict = (e: TaskRoundEvaluatedEvent): string => e.taskId;

/** @public */
export const foldRoundVerdict = (existing: TaskVerdicts | undefined, e: TaskRoundEvaluatedEvent): TaskVerdicts => {
  const attempts = new Map(existing ?? []);
  const rounds = new Map(attempts.get(e.attemptN) ?? []);
  rounds.set(e.roundN, {
    status: e.verdict,
    dimensions: e.failedDimensions,
    ...(e.headline !== undefined ? { headline: e.headline } : {}),
  });
  attempts.set(e.attemptN, rounds);
  return attempts;
};

/**
 * Lookup for `projectFlowProgress`. `roundN` is the round's position within the attempt (the loop
 * iteration) while events carry the on-disk global round index, so the n-th round of an attempt
 * is its n-th smallest recorded `roundN`. The attempt matches by number, else by position.
 */
export const roundVerdictLookup =
  (byTask: ReadonlyMap<string, TaskVerdicts>): RoundVerdictLookup =>
  ({ taskId, attemptN, roundN }) => {
    const attempts = byTask.get(taskId);
    if (attempts === undefined) return undefined;
    const attempt = attempts.get(attemptN) ?? [...attempts.entries()].sort(([a], [b]) => a - b)[attemptN - 1]?.[1];
    if (attempt === undefined) return undefined;
    const key = [...attempt.keys()].sort((a, b) => a - b)[roundN - 1];
    return key === undefined ? undefined : attempt.get(key);
  };

/** @public */
export interface UseTaskRoundVerdictsOptions {
  /** Flush cadence in ms. Test-only escape hatch. */
  readonly flushMs?: number;
}

export const useTaskRoundVerdicts = (
  bus: EventBus,
  opts: UseTaskRoundVerdictsOptions = {}
): ReadonlyMap<string, TaskVerdicts> =>
  useCoalescedMap<TaskRoundEvaluatedEvent, TaskVerdicts>(bus, {
    cap: TASK_VERDICT_CAP,
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    accept: isRoundEvaluated,
    keyOf: keyOfVerdict,
    fold: foldRoundVerdict,
  });
