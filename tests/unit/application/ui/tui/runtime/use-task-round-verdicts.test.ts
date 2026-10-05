import { describe, expect, it } from 'vitest';
import type { TaskRoundEvaluatedEvent } from '@src/business/observability/events.ts';
import {
  foldRoundVerdict,
  roundVerdictLookup,
  runTaskKey,
  type TaskVerdicts,
} from '@src/application/ui/tui/runtime/use-task-round-verdicts.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const ev = (
  over: Partial<TaskRoundEvaluatedEvent> & { iteration: NonNullable<TaskRoundEvaluatedEvent['iteration']> }
): TaskRoundEvaluatedEvent => ({
  type: 'task-round-evaluated',
  taskId: 't1',
  attemptN: 1,
  roundN: 1,
  verdict: 'passed',
  failedDimensions: [],
  chainSessionId: 'run-1',
  at: isoTimestamp('2026-05-09T10:00:00.000Z'),
  ...over,
});

const fold = (events: readonly TaskRoundEvaluatedEvent[]): Map<string, TaskVerdicts> => {
  const byRunTask = new Map<string, TaskVerdicts>();
  for (const e of events) {
    const key = runTaskKey(e.chainSessionId!, e.taskId);
    byRunTask.set(key, foldRoundVerdict(byRunTask.get(key), e));
  }
  return byRunTask;
};

describe('foldRoundVerdict', () => {
  it('folds events by attempt and round iteration without mutating the prior value', () => {
    const first = foldRoundVerdict(
      undefined,
      ev({
        iteration: { attempt: 1, round: 1 },
        verdict: 'failed',
        failedDimensions: ['correctness'],
        headline: 'nope',
      })
    );
    const second = foldRoundVerdict(first, ev({ iteration: { attempt: 1, round: 2 } }));
    const third = foldRoundVerdict(second, ev({ iteration: { attempt: 2, round: 1 }, verdict: 'malformed' }));
    expect(first.get(1)?.size).toBe(1);
    expect(second.get(1)?.get(1)).toEqual({ status: 'failed', dimensions: ['correctness'], headline: 'nope' });
    expect(second.get(1)?.get(2)).toEqual({ status: 'passed', dimensions: [] });
    expect(third.get(2)?.get(1)?.status).toBe('malformed');
  });
});

describe('roundVerdictLookup', () => {
  it("keeps a run's verdicts off a later run of the same task", () => {
    const byRunTask = fold([
      ev({ chainSessionId: 'run-1', attemptN: 1, roundN: 1, iteration: { attempt: 1, round: 1 }, verdict: 'failed' }),
      ev({ chainSessionId: 'run-1', attemptN: 2, roundN: 2, iteration: { attempt: 2, round: 1 }, verdict: 'failed' }),
      ev({ chainSessionId: 'run-2', attemptN: 3, roundN: 3, iteration: { attempt: 1, round: 1 }, verdict: 'passed' }),
    ]);
    expect(roundVerdictLookup(byRunTask, 'run-2')({ taskId: 't1', attemptN: 1, roundN: 1 })?.status).toBe('passed');
    expect(roundVerdictLookup(byRunTask, 'run-2')({ taskId: 't1', attemptN: 2, roundN: 1 })).toBeUndefined();
    expect(roundVerdictLookup(byRunTask, 'run-1')({ taskId: 't1', attemptN: 2, roundN: 1 })?.status).toBe('failed');
  });

  it('matches the exact iteration when an earlier attempt or round recorded no verdict', () => {
    const byRunTask = fold([ev({ attemptN: 5, roundN: 9, iteration: { attempt: 2, round: 2 }, verdict: 'failed' })]);
    const lookup = roundVerdictLookup(byRunTask, 'run-1');
    expect(lookup({ taskId: 't1', attemptN: 1, roundN: 1 })).toBeUndefined();
    expect(lookup({ taskId: 't1', attemptN: 2, roundN: 1 })).toBeUndefined();
    expect(lookup({ taskId: 't1', attemptN: 2, roundN: 2 })?.status).toBe('failed');
  });

  it('returns undefined for unknown tasks, runs and rounds', () => {
    const lookup = roundVerdictLookup(fold([ev({ iteration: { attempt: 1, round: 1 } })]), 'run-1');
    expect(lookup({ taskId: 'zz', attemptN: 1, roundN: 1 })).toBeUndefined();
    expect(lookup({ taskId: 't1', attemptN: 1, roundN: 9 })).toBeUndefined();
    expect(roundVerdictLookup(new Map(), 'run-1')({ taskId: 't1', attemptN: 1, roundN: 1 })).toBeUndefined();
  });
});
