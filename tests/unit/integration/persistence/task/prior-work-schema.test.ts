/**
 * `Task.quarantinedDiff` and `Attempt.priorWork` are additive fields read without a migration, so the
 * codec carries the whole compatibility story: round-trip both, read legacy rows unchanged, and read a
 * value this version can't interpret as absent instead of failing the whole `tasks.json`.
 */

import { describe, expect, it } from 'vitest';
import type { Result } from '@src/domain/result.ts';
import type { InProgressTask, Task, TodoTask } from '@src/domain/entity/task.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { decidePriorWork, stampPriorWorkOutcome } from '@src/domain/entity/task-prior-work.ts';
import {
  fromJsonTask,
  fromJsonTasksFile,
  toJsonTask,
  toJsonTasksFile,
} from '@src/integration/persistence/task/task.schema.ts';
import { FIXED_LATER, FIXED_NOW, makeTodoTask } from '@tests/fixtures/domain.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(`fixture: ${String(r.error)}`);
  return r.value as T;
};

const MSG = 'ralphctl/s1/t1/blocked-diff';
const STAT = { files: 5, insertions: 142, deletions: 38, partial: true as const };

/** What the codec actually sees on disk. */
const onDisk = (task: Task): Record<string, unknown> =>
  JSON.parse(JSON.stringify(toJsonTask(task))) as Record<string, unknown>;

const decidedTodo = (): TodoTask =>
  decidePriorWork(
    makeTodoTask({ name: 'decided' }),
    { choice: 'fresh', stashMessage: MSG, stat: STAT, entries: 2 },
    FIXED_LATER
  );

const stampedRunning = (): InProgressTask => {
  const started = unwrap(startNextAttempt(makeTodoTask({ name: 'stamped' }), FIXED_NOW, 'session-1'));
  return unwrap(
    stampPriorWorkOutcome(started, {
      kind: 'not-restored',
      stashMessage: MSG,
      reason: 'dirty-tree',
      uncommittedPaths: 3,
    })
  );
};

describe('task.schema — quarantinedDiff + priorWork', () => {
  it('round-trips a decided quarantined-diff fact', () => {
    const original = decidedTodo();
    const parsed = unwrap(fromJsonTask(onDisk(original)));
    expect(parsed).toStrictEqual(original);
  });

  it.each([
    { kind: 'restored', stashMessage: MSG, stat: STAT },
    { kind: 'kept-by-choice', stashMessage: MSG },
    { kind: 'not-restored', stashMessage: MSG, reason: 'pop-failed-tree-unverified' },
  ] as const)('round-trips a $kind attempt stamp', (outcome) => {
    const started = unwrap(startNextAttempt(makeTodoTask(), FIXED_NOW, 'session-1'));
    const original = unwrap(stampPriorWorkOutcome(started, outcome));
    const parsed = unwrap(fromJsonTask(onDisk(original)));
    expect(parsed.attempts.at(-1)?.priorWork).toStrictEqual(outcome);
    expect(parsed).toEqual(original);
  });

  it('parses a legacy row with neither field unchanged', () => {
    const legacy = onDisk(makeTodoTask({ name: 'legacy' }));
    const parsed = unwrap(fromJsonTask(legacy));
    expect('quarantinedDiff' in parsed).toBe(false);
    expect(parsed.attempts).toStrictEqual([]);
    expect(parsed.name).toBe('legacy');
  });

  it('reads an unknown nextAttempt as absent and keeps the rest of the fact', () => {
    const row = onDisk(decidedTodo());
    row['quarantinedDiff'] = { stashMessage: MSG, stat: STAT, nextAttempt: 'drop', decidedAt: FIXED_LATER };
    const parsed = unwrap(fromJsonTask(row));
    expect(parsed.quarantinedDiff?.stashMessage).toBe(MSG);
    expect(parsed.quarantinedDiff?.nextAttempt).toBeUndefined();
    expect(parsed.quarantinedDiff?.stat).toStrictEqual(STAT);
  });

  it('reads negative counts as absent', () => {
    const row = onDisk(decidedTodo());
    row['quarantinedDiff'] = { stashMessage: MSG, stat: { files: -1, insertions: 0, deletions: 0 }, entries: -2 };
    const parsed = unwrap(fromJsonTask(row));
    expect(parsed.quarantinedDiff?.stashMessage).toBe(MSG);
    expect(parsed.quarantinedDiff?.stat).toBeUndefined();
    expect(parsed.quarantinedDiff?.entries).toBeUndefined();
  });

  it('reads a fact with no stash message as no fact at all', () => {
    const row = onDisk(decidedTodo());
    row['quarantinedDiff'] = { nextAttempt: 'fresh' };
    expect(unwrap(fromJsonTask(row)).quarantinedDiff).toBeUndefined();
  });

  it.each([
    { kind: 'dropped', stashMessage: MSG },
    { kind: 'not-restored', stashMessage: MSG, reason: 'cosmic-ray' },
    'restored',
  ])('reads an unrecognised attempt stamp (%j) as absent', (garbage) => {
    const row = onDisk(stampedRunning());
    const attempts = row['attempts'] as Array<Record<string, unknown>>;
    attempts[0] = { ...attempts[0], priorWork: garbage };
    const parsed = unwrap(fromJsonTask(row));
    expect(parsed.attempts[0]?.priorWork).toBeUndefined();
    expect(parsed.attempts[0]?.status).toBe('running');
  });

  it('an unreadable value never fails the tasks.json read', () => {
    const file = JSON.parse(JSON.stringify(toJsonTasksFile([decidedTodo(), stampedRunning()]))) as {
      tasks: Array<Record<string, unknown>>;
    };
    const [first, second] = file.tasks;
    if (first === undefined || second === undefined) throw new Error('fixture');
    first['quarantinedDiff'] = 42;
    (second['attempts'] as Array<Record<string, unknown>>)[0] = {
      ...(second['attempts'] as Array<Record<string, unknown>>)[0],
      priorWork: { kind: 'from-the-future' },
    };
    const tasks = unwrap(fromJsonTasksFile(file));
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.quarantinedDiff).toBeUndefined();
    expect(tasks[1]?.attempts[0]?.priorWork).toBeUndefined();
  });
});
