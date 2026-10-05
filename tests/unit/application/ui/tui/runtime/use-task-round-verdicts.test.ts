import { describe, expect, it } from 'vitest';
import type { TaskRoundEvaluatedEvent } from '@src/business/observability/events.ts';
import {
  foldRoundVerdict,
  roundVerdictLookup,
  type TaskVerdicts,
} from '@src/application/ui/tui/runtime/use-task-round-verdicts.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const ev = (over: Partial<TaskRoundEvaluatedEvent>): TaskRoundEvaluatedEvent => ({
  type: 'task-round-evaluated',
  taskId: 't1',
  attemptN: 1,
  roundN: 1,
  verdict: 'passed',
  failedDimensions: [],
  at: isoTimestamp('2026-05-09T10:00:00.000Z'),
  ...over,
});

describe('foldRoundVerdict', () => {
  it('folds events by attempt and round without mutating the prior value', () => {
    const first = foldRoundVerdict(
      undefined,
      ev({ verdict: 'failed', failedDimensions: ['correctness'], headline: 'nope' })
    );
    const second = foldRoundVerdict(first, ev({ roundN: 2 }));
    const third = foldRoundVerdict(second, ev({ attemptN: 2, roundN: 3, verdict: 'malformed' }));
    expect(first.get(1)?.size).toBe(1);
    expect(second.get(1)?.get(1)).toEqual({ status: 'failed', dimensions: ['correctness'], headline: 'nope' });
    expect(second.get(1)?.get(2)).toEqual({ status: 'passed', dimensions: [] });
    expect(third.get(2)?.get(3)?.status).toBe('malformed');
  });
});

describe('roundVerdictLookup', () => {
  const byTask = new Map<string, TaskVerdicts>([
    [
      't1',
      [
        ev({ attemptN: 1, roundN: 4, verdict: 'failed' }),
        ev({ attemptN: 1, roundN: 5 }),
        ev({ attemptN: 2, roundN: 6, verdict: 'failed' }),
      ].reduce<TaskVerdicts | undefined>((acc, e) => foldRoundVerdict(acc, e), undefined)!,
    ],
  ]);

  it('maps the loop iteration within an attempt onto the nth recorded round, whatever the global index', () => {
    const lookup = roundVerdictLookup(byTask);
    expect(lookup({ taskId: 't1', attemptN: 1, roundN: 1 })?.status).toBe('failed');
    expect(lookup({ taskId: 't1', attemptN: 1, roundN: 2 })?.status).toBe('passed');
    expect(lookup({ taskId: 't1', attemptN: 2, roundN: 1 })?.status).toBe('failed');
  });

  it('returns undefined for unknown tasks and rounds', () => {
    const lookup = roundVerdictLookup(byTask);
    expect(lookup({ taskId: 'zz', attemptN: 1, roundN: 1 })).toBeUndefined();
    expect(lookup({ taskId: 't1', attemptN: 1, roundN: 9 })).toBeUndefined();
  });
});
