/**
 * `phaseAction`'s blocked-aware `review` / `done` arms. Before this change `review` said "Open a
 * pull request, then close" regardless of blocked tasks, and `done` said "No further work happens
 * here" even when a task was still blocked and reachable again via reopen — both are the exact
 * guidance surface that walked an operator into burying unfinished work / thinking closed work
 * was permanently unreachable.
 */

import { describe, expect, it } from 'vitest';
import { phaseAction } from '@src/application/ui/tui/views/sprint-detail-internals/header-card.tsx';
import { makeDoneSprint, makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { Task } from '@src/domain/entity/task.ts';

const blockedTask = (name: string): Task => {
  const result = markTaskBlocked(makeTodoTask({ name }), 'own failure', 'own');
  if (!result.ok) throw new Error(`fixture: ${result.error.message}`);
  return result.value;
};

describe('phaseAction — review phase', () => {
  it('names the blocked count instead of the generic PR/close guidance when tasks are blocked', () => {
    const sprint = makeReviewSprint();
    const action = phaseAction(sprint, [blockedTask('a'), blockedTask('b')]);
    expect(action?.label).toContain('2');
    expect(action?.label.toLowerCase()).toContain('blocked');
    expect(action?.hint).not.toContain('Open a pull request');
  });

  it('keeps the original PR/close guidance when nothing is blocked', () => {
    const sprint = makeReviewSprint();
    const action = phaseAction(sprint, []);
    expect(action?.label).toBe('Open a pull request, then close');
  });
});

describe('phaseAction — done phase', () => {
  it('tells the operator blocked work is reachable again via reopen, not a dead end', () => {
    const sprint = makeDoneSprint();
    const action = phaseAction(sprint, [blockedTask('a')]);
    expect(action?.label.toLowerCase()).toContain('blocked');
    expect(action?.hint.toLowerCase()).toContain('reopen');
  });

  it('reads as the original dead end when nothing is blocked', () => {
    const sprint = makeDoneSprint();
    const action = phaseAction(sprint, []);
    expect(action?.label).toBe('Sprint closed');
    expect(action?.hint).toContain('No further work happens here');
  });
});
