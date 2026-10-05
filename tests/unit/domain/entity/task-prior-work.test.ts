import { describe, expect, it } from 'vitest';
import type { Result } from '@src/domain/result.ts';
import type { PriorWorkOutcome } from '@src/domain/entity/attempt.ts';
import type { BlockCause, BlockedTask, InProgressTask, Task } from '@src/domain/entity/task.ts';
import {
  recordRunningAttemptCommit,
  recordRunningAttemptCritique,
  startNextAttempt,
} from '@src/domain/entity/task-attempts.ts';
import { markTaskBlocked, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import {
  clearStaleQuarantinedDiff,
  decidePriorWork,
  describeNotRestored,
  latestRetiredCritique,
  recommendedPriorWork,
  restoredWorkContext,
  stampPriorWorkOutcome,
  withQuarantinedDiff,
} from '@src/domain/entity/task-prior-work.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import type { DiffStat } from '@src/domain/value/diff-stat.ts';
import {
  commitSha,
  FIXED_LATER,
  FIXED_LATEST,
  FIXED_NOW,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(`fixture: ${String(r.error)}`);
  return r.value as T;
};

const MSG = 'ralphctl/s1/t1/blocked-diff';
const STAT: DiffStat = { files: 5, insertions: 142, deletions: 38 };

const blockedWith = (blockCause: BlockCause): BlockedTask =>
  unwrap(markTaskBlocked(makeTodoTask(), 'some reason', 'own', { blockCause }));

const ALL_CAUSES: readonly BlockCause[] = [
  'upstream-dependency',
  'generator-self-block',
  'pre-verify-red',
  'post-verify-regression',
  'fold-conflict',
  'worktree-setup-failure',
  'operator-cancelled',
  'budget-exhausted',
  'unknown',
];

/** A blocked task whose archived run ends with a critique — the one that rejected the diff. */
const blockedAfterCritique = (critique: string): BlockedTask => {
  const started = unwrap(startNextAttempt(makeTodoTask(), FIXED_NOW, 'session-1'));
  const critiqued = unwrap(recordRunningAttemptCritique(started, critique));
  const failed = unwrap(failCurrentAttempt(critiqued, FIXED_LATER, 'failed'));
  return withQuarantinedDiff(unwrap(markTaskBlocked(failed, 'attempt budget exhausted', 'own')), MSG, STAT, 1);
};

const restored: PriorWorkOutcome = { kind: 'restored', stashMessage: MSG, stat: STAT };

describe('recommendedPriorWork', () => {
  it.each(ALL_CAUSES)('blocked on %s', (cause) => {
    const expected = cause === 'generator-self-block' || cause === 'operator-cancelled' ? 'continue' : 'fresh';
    expect(recommendedPriorWork(blockedWith(cause))).toBe(expected);
  });

  it('continues a stuck in_progress task — an operator stop, not a quality failure', () => {
    expect(recommendedPriorWork(makeInProgressTaskWithRunningAttempt())).toBe('continue');
  });

  it('starts fresh when the block was never classified', () => {
    const { blockCause: _c, ...unclassified } = blockedWith('generator-self-block');
    void _c;
    expect(recommendedPriorWork(unclassified as BlockedTask)).toBe('fresh');
  });
});

describe('withQuarantinedDiff', () => {
  it('records the stash message, stat and entry count without touching blockedReason', () => {
    const blocked = blockedWith('budget-exhausted');
    const next = withQuarantinedDiff(blocked, MSG, STAT, 2);
    expect(next.quarantinedDiff).toStrictEqual({ stashMessage: MSG, stat: STAT, entries: 2 });
    expect(next.blockedReason).toBe(blocked.blockedReason);
  });

  it('returns the same object when the identical fact is already recorded', () => {
    const once = withQuarantinedDiff(blockedWith('budget-exhausted'), MSG, STAT, 1);
    expect(withQuarantinedDiff(once, MSG, { ...STAT }, 1)).toBe(once);
  });

  it('the newest measurement replaces the old one, and a stale decision is dropped', () => {
    const decidedEarlier: BlockedTask = {
      ...blockedWith('budget-exhausted'),
      quarantinedDiff: { stashMessage: MSG, stat: STAT, entries: 1, nextAttempt: 'fresh', decidedAt: FIXED_NOW },
    };
    const newer: DiffStat = { files: 1, insertions: 3, deletions: 0 };
    expect(withQuarantinedDiff(decidedEarlier, MSG, newer, 2).quarantinedDiff).toStrictEqual({
      stashMessage: MSG,
      stat: newer,
      entries: 2,
    });
  });
});

describe('decidePriorWork', () => {
  it('stamps the choice and when it was taken', () => {
    const decided = decidePriorWork(
      makeTodoTask(),
      { choice: 'fresh', stashMessage: MSG, stat: STAT, entries: 1 },
      FIXED_LATER
    );
    expect(decided.quarantinedDiff).toStrictEqual({
      stashMessage: MSG,
      stat: STAT,
      entries: 1,
      nextAttempt: 'fresh',
      decidedAt: FIXED_LATER,
    });
  });

  it('keeps the quarantine-time stat when the probe could not measure the stash', () => {
    const todo = { ...makeTodoTask(), quarantinedDiff: { stashMessage: MSG, stat: STAT, entries: 1 } };
    const decided = decidePriorWork(todo, { choice: 'continue', stashMessage: MSG }, FIXED_LATER);
    expect(decided.quarantinedDiff).toStrictEqual({
      stashMessage: MSG,
      stat: STAT,
      entries: 1,
      nextAttempt: 'continue',
      decidedAt: FIXED_LATER,
    });
  });

  it('records a decision even with no prior fact — the stash key is deterministic', () => {
    const decided = decidePriorWork(makeTodoTask(), { choice: 'continue', stashMessage: MSG }, FIXED_LATER);
    expect(decided.quarantinedDiff).toStrictEqual({
      stashMessage: MSG,
      nextAttempt: 'continue',
      decidedAt: FIXED_LATER,
    });
  });

  it('a change of mind overwrites the earlier choice', () => {
    const first = decidePriorWork(makeTodoTask(), { choice: 'fresh', stashMessage: MSG, stat: STAT }, FIXED_NOW);
    const second = decidePriorWork(first, { choice: 'continue', stashMessage: MSG }, FIXED_LATER);
    expect(second.quarantinedDiff?.nextAttempt).toBe('continue');
    expect(second.quarantinedDiff?.decidedAt).toBe(FIXED_LATER);
    expect(second.quarantinedDiff?.stat).toStrictEqual(STAT);
  });
});

describe('stampPriorWorkOutcome', () => {
  const runningWithFact = (): InProgressTask => ({
    ...makeInProgressTaskWithRunningAttempt(),
    quarantinedDiff: { stashMessage: MSG, stat: STAT, nextAttempt: 'continue', decidedAt: FIXED_NOW },
  });

  it('restored: stamps the running attempt and clears the consumed fact', () => {
    const stamped = unwrap(stampPriorWorkOutcome(runningWithFact(), restored));
    expect(stamped.attempts.at(-1)?.priorWork).toStrictEqual(restored);
    expect('quarantinedDiff' in stamped).toBe(false);
  });

  it.each<PriorWorkOutcome>([
    { kind: 'kept-by-choice', stashMessage: MSG },
    { kind: 'not-restored', stashMessage: MSG, reason: 'dirty-tree', uncommittedPaths: 3 },
  ])('$kind: stamps the attempt and keeps the fact — the entry is still in the stash', (outcome) => {
    const task = runningWithFact();
    const stamped = unwrap(stampPriorWorkOutcome(task, outcome));
    expect(stamped.attempts.at(-1)?.priorWork).toStrictEqual(outcome);
    expect(stamped.quarantinedDiff).toStrictEqual(task.quarantinedDiff);
  });

  it('a re-stamp after a failed pop re-establishes the fact the restored pre-stamp cleared', () => {
    const pre = unwrap(stampPriorWorkOutcome(runningWithFact(), restored));
    const re = unwrap(stampPriorWorkOutcome(pre, { kind: 'not-restored', stashMessage: MSG, reason: 'pop-failed' }));
    expect(re.attempts.at(-1)?.priorWork?.kind).toBe('not-restored');
    expect(re.quarantinedDiff).toStrictEqual({ stashMessage: MSG });
  });

  it('rejects a task with no running attempt', () => {
    const settled = unwrap(failCurrentAttempt(makeInProgressTaskWithRunningAttempt(), FIXED_LATER, 'failed'));
    const res = stampPriorWorkOutcome(settled as InProgressTask, restored);
    expect(res.ok).toBe(false);
  });
});

describe('clearStaleQuarantinedDiff', () => {
  it('drops the fact and leaves the rest of the task alone', () => {
    const todo = { ...makeTodoTask(), quarantinedDiff: { stashMessage: MSG } };
    const cleared = clearStaleQuarantinedDiff(todo);
    expect('quarantinedDiff' in cleared).toBe(false);
    expect(cleared.id).toBe(todo.id);
  });

  it('returns the same object when there is nothing to clear', () => {
    const todo = makeTodoTask();
    expect(clearStaleQuarantinedDiff(todo)).toBe(todo);
  });
});

describe('latestRetiredCritique', () => {
  it('reads the newest critique of the run the last unblock archived', () => {
    const revived = unwrap(unblockTask(blockedAfterCritique('missing null check in parse()')));
    expect(revived.attempts).toHaveLength(0);
    expect(latestRetiredCritique(revived)).toBe('missing null check in parse()');
  });

  it('is undefined before any unblock, and when the archived run has no critique', () => {
    expect(latestRetiredCritique(makeTodoTask())).toBeUndefined();
    const noCritique = unwrap(failCurrentAttempt(makeInProgressTaskWithRunningAttempt(), FIXED_LATER, 'failed'));
    const blocked = unwrap(markTaskBlocked(noCritique, 'attempt budget exhausted', 'own'));
    expect(latestRetiredCritique(unwrap(unblockTask(blocked)))).toBeUndefined();
  });
});

describe('restoredWorkContext', () => {
  const revivedAndRestored = (): InProgressTask => {
    const revived = unwrap(unblockTask(blockedAfterCritique('rejected: retries never back off')));
    const started = unwrap(startNextAttempt(revived, FIXED_NOW, 'session-2'));
    return unwrap(stampPriorWorkOutcome(started, restored));
  };

  it('pairs the restored stat with the archived critique on the attempt that popped', () => {
    expect(restoredWorkContext(revivedAndRestored())).toStrictEqual({
      stat: STAT,
      critique: 'rejected: retries never back off',
    });
  });

  it('finds the restored stamp on an interrupted earlier attempt after a cold restart', () => {
    const interrupted = unwrap(
      failCurrentAttempt(revivedAndRestored(), FIXED_LATER, 'aborted', { abortCause: 'harness-interrupted' })
    );
    const resumed = unwrap(startNextAttempt(interrupted, FIXED_LATEST, 'session-3'));
    expect(resumed.attempts).toHaveLength(2);
    expect(restoredWorkContext(resumed)?.critique).toBe('rejected: retries never back off');
  });

  it('stops at a settled retry — the retry stash took the restored draft out of the tree', () => {
    const retried = unwrap(failCurrentAttempt(revivedAndRestored(), FIXED_LATER, 'failed'));
    expect(restoredWorkContext(retried)).toBeUndefined();
    const next = unwrap(startNextAttempt(retried, FIXED_LATEST, 'session-3'));
    expect(next.attempts).toHaveLength(2);
    expect(restoredWorkContext(next)).toBeUndefined();
  });

  it('is undefined on a blocked task — the block quarantined the draft again', () => {
    const selfBlocked = unwrap(
      failCurrentAttempt(revivedAndRestored(), FIXED_LATER, 'aborted', { abortCause: 'self-blocked' })
    );
    expect(restoredWorkContext(unwrap(markTaskBlocked(selfBlocked, 'needs an answer', 'own')))).toBeUndefined();
  });

  it('walks past an attempt a watchdog kill cut short — nothing stashed its tree', () => {
    const killed = unwrap(
      failCurrentAttempt(revivedAndRestored(), FIXED_LATER, 'aborted', { abortCause: 'watchdog-killed' })
    );
    const next = unwrap(startNextAttempt(killed, FIXED_LATEST, 'session-3'));
    expect(restoredWorkContext(next)?.stat).toStrictEqual(STAT);
  });

  it('stops at the first committed attempt — the draft is no longer uncommitted', () => {
    const committed = unwrap(recordRunningAttemptCommit(revivedAndRestored(), commitSha('a'.repeat(40))));
    expect(restoredWorkContext(committed)).toBeUndefined();
  });

  it('is undefined when nothing was restored', () => {
    const task: Task = unwrap(
      stampPriorWorkOutcome(makeInProgressTaskWithRunningAttempt(), { kind: 'kept-by-choice', stashMessage: MSG })
    );
    expect(restoredWorkContext(task)).toBeUndefined();
    expect(restoredWorkContext(makeTodoTask())).toBeUndefined();
  });

  it('omits the critique when the archived run recorded none', () => {
    const started = unwrap(startNextAttempt(makeTodoTask(), FIXED_NOW, 'session-1'));
    expect(restoredWorkContext(unwrap(stampPriorWorkOutcome(started, restored)))).toStrictEqual({ stat: STAT });
  });
});

describe('describeNotRestored', () => {
  it('counts the uncommitted changes that kept the diff out, singular and plural', () => {
    expect(describeNotRestored('dirty-tree', 1)).toBe('tree had 1 uncommitted change');
    expect(describeNotRestored('dirty-tree', 3)).toBe('tree had 3 uncommitted changes');
    expect(describeNotRestored('dirty-tree')).toBe('tree had uncommitted changes');
  });

  it('names every other reason', () => {
    expect(describeNotRestored('tree-probe-failed')).toBe('git status failed');
    expect(describeNotRestored('pop-failed')).toBe('stash pop conflicted and the tree was reset');
    expect(describeNotRestored('pop-failed-tree-unverified')).toBe("stash pop failed and the tree couldn't be checked");
    expect(describeNotRestored('stash-list-failed')).toBe('git stash list failed');
  });
});
