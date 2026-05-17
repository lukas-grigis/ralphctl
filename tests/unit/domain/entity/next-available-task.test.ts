import { describe, expect, it } from 'vitest';
import {
  markTaskBlocked,
  markTaskDone,
  nextAvailableTask,
  recordRunningAttemptVerification,
  startNextAttempt,
} from '@src/domain/entity/task.ts';
import { FIXED_LATER, FIXED_NOW, makeTodoTask } from '@tests/fixtures/domain.ts';

const through = <T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!r.ok) throw new Error('expected ok');
  return r.value;
};

describe('nextAvailableTask', () => {
  it('returns undefined when empty', () => {
    expect(nextAvailableTask([])).toBeUndefined();
  });

  it('picks the only todo when no deps', () => {
    const a = makeTodoTask({ name: 'a' });
    expect(nextAvailableTask([a])?.id).toBe(a.id);
  });

  it('picks lowest-order ready todo', () => {
    const a = makeTodoTask({ name: 'a', order: 5 });
    const b = makeTodoTask({ name: 'b', order: 2 });
    const c = makeTodoTask({ name: 'c', order: 9 });
    expect(nextAvailableTask([a, b, c])?.id).toBe(b.id);
  });

  it('skips a todo whose dependency is not done', () => {
    const a = makeTodoTask({ name: 'a' });
    const b = makeTodoTask({ name: 'b', dependsOn: [a.id], order: 2 });
    // a is still todo → b is gated → only a is ready
    expect(nextAvailableTask([a, b])?.id).toBe(a.id);
  });

  it('returns the dependent todo once the dep is done', () => {
    const a = makeTodoTask({ name: 'a' });
    const ip = through(startNextAttempt(a, FIXED_NOW));
    const verified = through(recordRunningAttemptVerification(ip));
    const done = through(markTaskDone(verified, FIXED_LATER));
    const b = makeTodoTask({ name: 'b', dependsOn: [a.id], order: 1 });
    const next = nextAvailableTask([done, b]);
    expect(next?.id).toBe(b.id);
  });

  it('skips blocked tasks', () => {
    const a = makeTodoTask({ name: 'a' });
    const blocked = through(markTaskBlocked(a, 'wait'));
    expect(nextAvailableTask([blocked])).toBeUndefined();
  });
});
