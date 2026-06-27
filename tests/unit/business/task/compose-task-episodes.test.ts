import { describe, expect, it } from 'vitest';
import { composeTaskEpisodes } from '@src/business/task/compose-task-episodes.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import {
  FIXED_LATER,
  FIXED_NOW,
  makeDoneTask,
  makeDoneTaskWithWarning,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

const SPRINT_ID = 'sprint-episodes-1' as unknown as SprintId;
// A TaskId guaranteed not to collide with any fixture-generated uuid → no exclusion.
const NO_CURRENT = '00000000-0000-0000-0000-000000000000' as unknown as TaskId;

const makeBlockedTask = (opts: {
  blockKind: 'own' | 'upstream';
  blockedReason: string;
  name?: string;
  description?: string;
  withAttempt?: boolean;
}): BlockedTask => {
  const base =
    opts.withAttempt === true
      ? makeInProgressTaskWithRunningAttempt()
      : makeTodoTask(opts.name !== undefined ? { name: opts.name } : {});
  return {
    ...base,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    status: 'blocked',
    blockedReason: opts.blockedReason,
    blockKind: opts.blockKind,
  } as BlockedTask;
};

describe('composeTaskEpisodes', () => {
  it('maps a done task to a success episode with an honest attempt-count learning', () => {
    const done = makeDoneTask({ name: 'wire-the-thing' });
    const episodes = composeTaskEpisodes([done], NO_CURRENT, SPRINT_ID);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      taskId: String(done.id),
      sprintId: 'sprint-episodes-1',
      goal: 'wire-the-thing',
      outcome: 'success',
      keyLearnings: 'verified after 1 attempt',
      timestamp: FIXED_LATER, // verified attempt's finishedAt
    });
  });

  it('names the done-with-warning kind in the success episode learning', () => {
    const done = makeDoneTaskWithWarning({ warning: { kind: 'plateau', dimensions: ['correctness'] } });
    const [episode] = composeTaskEpisodes([done], NO_CURRENT, SPRINT_ID);
    expect(episode?.outcome).toBe('success');
    expect(episode?.keyLearnings).toContain('done-with-warning: plateau');
  });

  it('maps an own-failure blocked task to a blocked episode carrying the block reason', () => {
    const blocked = makeBlockedTask({
      blockKind: 'own',
      blockedReason: 'verify script kept failing on the migration step',
      withAttempt: true,
    });
    const [episode] = composeTaskEpisodes([blocked], NO_CURRENT, SPRINT_ID);
    expect(episode?.outcome).toBe('blocked');
    expect(episode?.keyLearnings).toBe('verify script kept failing on the migration step');
    // withAttempt → running attempt's startedAt is the real timestamp.
    expect(episode?.timestamp).toBe(FIXED_NOW);
  });

  it('maps an upstream cascade-blocked task to an abandoned episode', () => {
    const blocked = makeBlockedTask({
      blockKind: 'upstream',
      blockedReason: 'blocked upstream: prerequisite task did not complete',
    });
    const [episode] = composeTaskEpisodes([blocked], NO_CURRENT, SPRINT_ID);
    expect(episode?.outcome).toBe('abandoned');
    expect(episode?.keyLearnings).toBe('blocked upstream: prerequisite task did not complete');
    // No attempts (cascade-blocked before running) → deterministic epoch sentinel, still valid ISO.
    expect(episode?.timestamp).toBe('1970-01-01T00:00:00.000Z');
    expect(() => new Date(String(episode?.timestamp)).toISOString()).not.toThrow();
  });

  it('excludes the current task from the derived episodes', () => {
    const done = makeDoneTask({ name: 'sibling-done' });
    const current = makeDoneTask({ name: 'the-current-one' });
    const episodes = composeTaskEpisodes([done, current], current.id, SPRINT_ID);
    expect(episodes.map((e) => e.taskId)).toEqual([String(done.id)]);
  });

  it('excludes unsettled tasks (todo / in_progress)', () => {
    const todo = makeTodoTask({ name: 'not-started' });
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const done = makeDoneTask({ name: 'settled' });
    const episodes = composeTaskEpisodes([todo, inProgress, done], NO_CURRENT, SPRINT_ID);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.taskId).toBe(String(done.id));
  });

  it('preserves input order across mixed settled tasks', () => {
    const done1 = makeDoneTask({ name: 'first' });
    const blocked = makeBlockedTask({ blockKind: 'own', blockedReason: 'second failed' });
    const done2 = makeDoneTask({ name: 'third' });
    const episodes = composeTaskEpisodes([done1, blocked, done2], NO_CURRENT, SPRINT_ID);
    expect(episodes.map((e) => e.taskId)).toEqual([String(done1.id), String(blocked.id), String(done2.id)]);
  });

  it('prefers the description over the name for the episode goal', () => {
    const blocked = makeBlockedTask({
      blockKind: 'own',
      blockedReason: 'reason',
      name: 'short-name',
      description: 'A fuller description of what this task was meant to accomplish',
    });
    const [episode] = composeTaskEpisodes([blocked], NO_CURRENT, SPRINT_ID);
    expect(episode?.goal).toBe('A fuller description of what this task was meant to accomplish');
  });

  it('clamps a very long block reason to a single bounded line', () => {
    const longReason = 'x'.repeat(300);
    const blocked = makeBlockedTask({ blockKind: 'own', blockedReason: longReason });
    const [episode] = composeTaskEpisodes([blocked], NO_CURRENT, SPRINT_ID);
    expect(episode?.keyLearnings.length).toBeLessThanOrEqual(120);
    expect(episode?.keyLearnings.endsWith('…')).toBe(true);
  });

  it('returns an empty array when there are no settled siblings', () => {
    const todo = makeTodoTask();
    expect(composeTaskEpisodes([todo] as readonly Task[], NO_CURRENT, SPRINT_ID)).toEqual([]);
    expect(composeTaskEpisodes([], NO_CURRENT, SPRINT_ID)).toEqual([]);
  });
});
