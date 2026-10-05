/**
 * Per-round evaluator verdicts — folds `task-round-evaluated` events into
 * `(run, taskId) → attempt iteration → round iteration → verdict`. The event names its run and the
 * loop iterations it was evaluated in, so attribution is exact: no windowing over the bucketed
 * signal stream, and no guessing which run's attempt a row means. Retention mirrors
 * `use-task-round-tracker.ts`: LRU-capped at {@link TASK_VERDICT_CAP} entries, coalesced into one
 * commit per window.
 */

import type { AppEvent, TaskRoundEvaluatedEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { useCoalescedMap } from '@src/application/ui/tui/runtime/use-coalesced-map.ts';
import type { RoundVerdict, RoundVerdictLookup } from '@src/application/ui/tui/runtime/flow-progress.ts';

export const TASK_VERDICT_CAP = 500;

/** attempt iteration → round iteration → verdict, for one task in one run. */
export type TaskVerdicts = ReadonlyMap<number, ReadonlyMap<number, RoundVerdict>>;

type AttributedEvent = TaskRoundEvaluatedEvent & {
  readonly chainSessionId: string;
  readonly iteration: NonNullable<TaskRoundEvaluatedEvent['iteration']>;
};

// An event that names no run or iteration cannot be placed on a row.
const isAttributedVerdict = (e: AppEvent): e is AttributedEvent =>
  e.type === 'task-round-evaluated' && e.chainSessionId !== undefined && e.iteration !== undefined;

/** Map key for one task within one run. */
export const runTaskKey = (sessionId: string, taskId: string): string => `${sessionId}\u0000${taskId}`;

/** @public */
export const foldRoundVerdict = (existing: TaskVerdicts | undefined, e: TaskRoundEvaluatedEvent): TaskVerdicts => {
  if (e.iteration === undefined) return existing ?? new Map();
  const { attempt, round } = e.iteration;
  const attempts = new Map(existing ?? []);
  const rounds = new Map(attempts.get(attempt) ?? []);
  rounds.set(round, {
    status: e.verdict,
    dimensions: e.failedDimensions,
    ...(e.headline !== undefined ? { headline: e.headline } : {}),
  });
  attempts.set(attempt, rounds);
  return attempts;
};

/** Lookup for `projectFlowProgress` over one run: the query's numbers are that run's loop iterations. */
export const roundVerdictLookup =
  (byRunTask: ReadonlyMap<string, TaskVerdicts>, sessionId: string): RoundVerdictLookup =>
  ({ taskId, attemptN, roundN }) =>
    byRunTask.get(runTaskKey(sessionId, taskId))?.get(attemptN)?.get(roundN);

/** @public */
export interface UseTaskRoundVerdictsOptions {
  /** Flush cadence in ms. Test-only escape hatch. */
  readonly flushMs?: number;
}

export const useTaskRoundVerdicts = (
  bus: EventBus,
  opts: UseTaskRoundVerdictsOptions = {}
): ReadonlyMap<string, TaskVerdicts> =>
  useCoalescedMap<AttributedEvent, TaskVerdicts>(bus, {
    cap: TASK_VERDICT_CAP,
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    accept: isAttributedVerdict,
    keyOf: (e) => runTaskKey(e.chainSessionId, e.taskId),
    fold: foldRoundVerdict,
  });
