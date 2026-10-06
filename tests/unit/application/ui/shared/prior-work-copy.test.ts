import { describe, expect, it } from 'vitest';
import type { PriorWorkOutcome } from '@src/domain/entity/attempt.ts';
import type { QuarantinedDiff, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { priorWorkNotice } from '@src/application/ui/shared/prior-work-copy.ts';
import { makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const stat = { files: 5, insertions: 142, deletions: 38 };
const fact = (over: Partial<QuarantinedDiff> = {}): QuarantinedDiff => ({ stashMessage: 'm', stat, ...over });

const todo = (q?: QuarantinedDiff): Task => ({ ...makeTodoTask(), ...(q !== undefined ? { quarantinedDiff: q } : {}) });
const blocked = (q: QuarantinedDiff): Task => {
  const r = markTaskBlocked(makeTodoTask(), 'attempt budget exhausted', 'own', { blockCause: 'budget-exhausted' });
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.value, quarantinedDiff: q };
};
const running = (priorWork: PriorWorkOutcome, q?: QuarantinedDiff): Task => {
  const t = makeInProgressTaskWithRunningAttempt();
  const last = t.attempts[t.attempts.length - 1];
  if (last === undefined) throw new Error('no attempt');
  return { ...t, attempts: [...t.attempts.slice(0, -1), { ...last, priorWork }], ...(q ? { quarantinedDiff: q } : {}) };
};

describe('priorWorkNotice', () => {
  it('is absent without a fact or stamp', () => {
    expect(priorWorkNotice(todo())).toBeUndefined();
  });

  it('blocked: execute vs sprint-detail wording', () => {
    const t = blocked(fact());
    expect(priorWorkNotice(t, 'execute')).toEqual({
      tone: 'dim',
      icon: 'i',
      text: 'rejected diff kept in git stash · 5 files +142 -38 · u decides what the next attempt does',
    });
    expect(priorWorkNotice(t, 'sprint-detail')?.text).toContain('u unblocks and decides what the next attempt does');
  });

  it('blocked: no u clause while u is unavailable (a run is live)', () => {
    expect(priorWorkNotice(blocked(fact()), 'execute', { unblockKey: false })?.text).toBe(
      'rejected diff kept in git stash · 5 files +142 -38'
    );
  });

  it('todo: fresh / continue / legacy', () => {
    expect(priorWorkNotice(todo(fact({ nextAttempt: 'fresh' })))?.text).toBe(
      'next attempt starts fresh · rejected diff stays in git stash (5 files +142 -38)'
    );
    expect(priorWorkNotice(todo(fact({ nextAttempt: 'continue' })))?.text).toBe(
      'next attempt continues from the rejected diff · 5 files +142 -38'
    );
    expect(priorWorkNotice(todo(fact()))?.text).toBe(
      'next attempt restores the rejected diff in git stash (no choice recorded)'
    );
  });

  it('attempt stamps', () => {
    expect(priorWorkNotice(running({ kind: 'restored', stashMessage: 'm', stat }))?.text).toBe(
      'continued from earlier rejected work · 5 files +142 -38'
    );
    expect(priorWorkNotice(running({ kind: 'kept-by-choice', stashMessage: 'm' }))?.text).toBe(
      'started fresh by choice · rejected diff still in git stash'
    );
    const n = priorWorkNotice(
      running({ kind: 'not-restored', stashMessage: 'm', reason: 'dirty-tree', uncommittedPaths: 3 })
    );
    expect(n?.tone).toBe('warning');
    expect(n?.text).toBe('earlier rejected work not restored — tree had 3 uncommitted changes; still in git stash');
  });

  it.each([
    ['tree-probe-failed', 'git status failed'],
    ['pop-failed', 'stash pop conflicted and the tree was reset'],
    ['pop-failed-tree-unverified', "stash pop failed and the tree couldn't be checked"],
    ['stash-list-failed', 'git stash list failed'],
  ] as const)('reason %s', (reason, text) => {
    expect(priorWorkNotice(running({ kind: 'not-restored', stashMessage: 'm', reason }))?.text).toContain(text);
  });

  it('the current-attempt stamp beats the task fact', () => {
    const t = running({ kind: 'kept-by-choice', stashMessage: 'm' }, fact({ nextAttempt: 'continue' }));
    expect(priorWorkNotice(t)?.text).toContain('started fresh by choice');
  });
});
