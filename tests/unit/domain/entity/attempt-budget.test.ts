import { describe, expect, it } from 'vitest';
import type { Result } from '@src/domain/result.ts';
import type { AbortCause } from '@src/domain/entity/attempt.ts';
import type { Task } from '@src/domain/entity/task.ts';
import {
  budgetedAttemptCount,
  MAX_CONSECUTIVE_FREE_ATTEMPTS,
  startNextAttempt,
} from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { FIXED_NOW, makeTodoTask } from '@tests/fixtures/domain.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(String(r.error));
  return r.value as T;
};

/** Run one attempt per entry: `failed` is a model failure, anything else an abort with that cause. */
const attemptsEndingIn = (outcomes: ReadonlyArray<AbortCause | 'failed'>, maxAttempts?: number): Task => {
  let task: Task = makeTodoTask(maxAttempts !== undefined ? { maxAttempts } : {});
  for (const outcome of outcomes) {
    const running: Task = unwrap(startNextAttempt(task, FIXED_NOW));
    task = unwrap(
      outcome === 'failed'
        ? failCurrentAttempt(running, FIXED_NOW, 'failed')
        : failCurrentAttempt(running, FIXED_NOW, 'aborted', { abortCause: outcome })
    );
  }
  return task;
};

const interrupted = (n: number): AbortCause[] => Array.from({ length: n }, () => 'harness-interrupted');

describe('budgetedAttemptCount — free attempts', () => {
  it(`spends nothing on the first ${String(MAX_CONSECUTIVE_FREE_ATTEMPTS)} interruptions in a row, then counts each one`, () => {
    expect(budgetedAttemptCount(attemptsEndingIn(interrupted(MAX_CONSECUTIVE_FREE_ATTEMPTS)))).toBe(0);
    expect(budgetedAttemptCount(attemptsEndingIn(interrupted(MAX_CONSECUTIVE_FREE_ATTEMPTS + 1)))).toBe(1);
    expect(budgetedAttemptCount(attemptsEndingIn(interrupted(MAX_CONSECUTIVE_FREE_ATTEMPTS + 2)))).toBe(2);
  });

  it('starts a fresh streak after an attempt that ran to a verdict', () => {
    const task = attemptsEndingIn([...interrupted(3), 'failed', ...interrupted(3)]);
    expect(budgetedAttemptCount(task)).toBe(1);
  });

  it('treats an operator cancel like an interruption, sharing the same streak', () => {
    expect(budgetedAttemptCount(attemptsEndingIn(['user-cancel']))).toBe(0);
    expect(
      budgetedAttemptCount(attemptsEndingIn(['user-cancel', 'harness-interrupted', 'user-cancel', 'user-cancel']))
    ).toBe(1);
  });

  it('keeps counting crashes the model owns', () => {
    expect(budgetedAttemptCount(attemptsEndingIn(['process-crash', 'watchdog-killed']))).toBe(2);
  });

  it('blocks a task that is interrupted over and over once the capped streak spends its budget', () => {
    const task = attemptsEndingIn(interrupted(MAX_CONSECUTIVE_FREE_ATTEMPTS + 2), 2);
    expect(task.status).toBe('blocked');
  });
});
