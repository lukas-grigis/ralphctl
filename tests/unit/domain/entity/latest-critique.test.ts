import { describe, expect, it } from 'vitest';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import { recordRunningAttemptCritique, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { latestCritique } from '@src/domain/entity/task-graph.ts';
import { FIXED_LATER, FIXED_NOW, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const withCritique = (task: InProgressTask, critique: string): InProgressTask => {
  const r = recordRunningAttemptCritique(task, critique);
  if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
  return r.value;
};

const settleAndStartNext = (task: InProgressTask): InProgressTask => {
  // Mirrors what `start-attempt`'s resume path does: settle the running attempt as aborted,
  // then open a fresh attempt on top.
  const aborted = failCurrentAttempt(task, FIXED_NOW, 'aborted');
  if (!aborted.ok) throw new Error(`fixture: ${aborted.error.message}`);
  if (aborted.value.status !== 'in_progress') {
    throw new Error(`fixture: task settled to ${aborted.value.status}; bump maxAttempts in the fixture`);
  }
  const next = startNextAttempt(aborted.value, FIXED_LATER);
  if (!next.ok) throw new Error(`fixture: ${next.error.message}`);
  return next.value;
};

describe('latestCritique', () => {
  it('returns undefined for a todo task (no attempts yet)', () => {
    expect(latestCritique(makeTodoTask())).toBeUndefined();
  });

  it('returns undefined when the running attempt has no critique', () => {
    expect(latestCritique(makeInProgressTaskWithRunningAttempt())).toBeUndefined();
  });

  it('returns the critique on the current running attempt (turn N+1 within one attempt)', () => {
    const task = withCritique(makeInProgressTaskWithRunningAttempt(), 'fix the failing test');
    expect(latestCritique(task)).toBe('fix the failing test');
  });

  it('carries critique forward across attempts (the resume case)', () => {
    // attempt 1: ran an evaluator turn, recorded a critique, then the chain crashed.
    // Re-launch settles attempt 1 as `aborted` and opens attempt 2 (running, no critique).
    // The new attempt's first generator turn must still see attempt 1's critique.
    const a1 = withCritique(
      makeInProgressTaskWithRunningAttempt({ maxAttempts: 3 }),
      'tree is dirty, commit the changes'
    );
    const a2 = settleAndStartNext(a1);
    expect(latestCritique(a2)).toBe('tree is dirty, commit the changes');
  });

  it('prefers the running attempt critique over older aborted-attempt critique (newer wins)', () => {
    const a1 = withCritique(makeInProgressTaskWithRunningAttempt({ maxAttempts: 3 }), 'older critique');
    const a2 = withCritique(settleAndStartNext(a1), 'newer critique');
    expect(latestCritique(a2)).toBe('newer critique');
  });

  it('skips whitespace-only critique fields and walks further back', () => {
    // First seed a real critique on attempt 1.
    const a1 = withCritique(makeInProgressTaskWithRunningAttempt({ maxAttempts: 3 }), 'real critique');
    // Settle, start attempt 2, and stamp an *empty/whitespace* critique on attempt 2 — should
    // fall through to attempt 1's real one.
    const a2 = settleAndStartNext(a1);
    // We can't record an empty critique through `recordRunningAttemptCritique` (it rejects);
    // but a future parser bug could leave whitespace-only on disk. Simulate by direct
    // attempt-array splice.
    const trimmed: InProgressTask = {
      ...a2,
      attempts: a2.attempts.map((att, i) => (i === a2.attempts.length - 1 ? { ...att, critique: '   ' } : att)),
    };
    expect(latestCritique(trimmed)).toBe('real critique');
  });
});
