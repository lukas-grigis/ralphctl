import { describe, expect, it } from 'vitest';
import { shouldTransitionToReview } from '@src/application/flows/implement/flow.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { makeDoneTask, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const blocked = (name: string): BlockedTask => ({
  ...makeTodoTask({ name }),
  status: 'blocked',
  blockedReason: 'unit-test reason',
});

describe('shouldTransitionToReview', () => {
  it('does NOT transition while a task is still todo (premature-flip fix)', () => {
    // The prior `some(done)` predicate flipped here — that is the bug.
    const tasks: Task[] = [makeDoneTask({ name: 'a' }), makeTodoTask({ name: 'b' })];
    expect(shouldTransitionToReview(tasks)).toBe(false);
  });

  it('does NOT transition while a task is still in_progress', () => {
    const tasks: Task[] = [makeDoneTask({ name: 'a' }), makeInProgressTaskWithRunningAttempt()];
    expect(shouldTransitionToReview(tasks)).toBe(false);
  });

  it('transitions when every task has settled and at least one is done (mixed end state)', () => {
    const tasks: Task[] = [makeDoneTask({ name: 'a' }), blocked('b')];
    expect(shouldTransitionToReview(tasks)).toBe(true);
  });

  it('transitions when every task is done', () => {
    const tasks: Task[] = [makeDoneTask({ name: 'a' }), makeDoneTask({ name: 'b' })];
    expect(shouldTransitionToReview(tasks)).toBe(true);
  });

  it('does NOT transition when all tasks are blocked (nothing to review — stay active)', () => {
    const tasks: Task[] = [blocked('a'), blocked('b')];
    expect(shouldTransitionToReview(tasks)).toBe(false);
  });

  it('does NOT transition on an empty / undefined task list', () => {
    expect(shouldTransitionToReview([])).toBe(false);
    expect(shouldTransitionToReview(undefined)).toBe(false);
  });
});
