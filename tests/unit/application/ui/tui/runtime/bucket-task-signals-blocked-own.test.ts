/**
 * A task blocked on its OWN merits (budget exhausted, red post-task-verify, generator self-block)
 * runs its ENTIRE subchain to the terminal `uninstall-skills` leaf with no failed/aborted/skipped
 * substep anywhere — `settleAttemptUseCase` records the block on the task entity and returns
 * `Result.ok` so the chain can continue. `bucketTaskSignals` alone therefore resolves this to
 * `completed`, identical to a genuine pass (see `bucket-task-signals-blocked-dependency.test.ts`
 * for the DIFFERENT case this does catch: an upstream dependency-gate skip).
 *
 * `overlayEntityBlockedStatus` is the correction: it cross-references the polled task entities and
 * stamps `blocked` back onto a bucket the trace alone got wrong — and, once the operator unblocks
 * such a task after the run, `pending`, so the revived task never reads as done.
 */

import { describe, expect, it } from 'vitest';
import type { Trace } from '@src/application/chain/trace.ts';
import { bucketTaskSignals, overlayEntityBlockedStatus } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { makeDoneTask, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const SELF_BLOCKED = '01933fbb-1111-7000-8000-000000000001';
const SIBLING = '01933fbb-2222-7000-8000-000000000002';

/** The exact trace shape a task blocked on its own merits produces: every substep completed. */
const cleanRunTrace = (taskId: string): Trace => [
  { elementName: `dependency-gate-${taskId}`, status: 'completed', durationMs: 2 },
  { elementName: `generator-${taskId}`, status: 'completed', durationMs: 40 },
  { elementName: `commit-task-${taskId}`, status: 'completed', durationMs: 5 },
  { elementName: `uninstall-skills-${taskId}`, status: 'completed', durationMs: 3 },
];

/** The polled entity of a task that really finished — `done`, re-keyed onto a test id. */
const doneEntity = (id: string): Task => ({ ...makeDoneTask({ name: 'Actually finished' }), id: id as TaskId });

/**
 * The polled entity right after the operator pressed `u` on an own-failure block: the run left one
 * attempt behind, the block landed on the entity, and `unblockTask` put it back on `todo`.
 */
const revivedEntity = (id: string): Task => {
  const inProgress = makeInProgressTaskWithRunningAttempt();
  const blocked = markTaskBlocked({ ...inProgress, id: id as TaskId }, 'budget exhausted after 3 attempts', 'own');
  if (!blocked.ok) throw new Error('fixture setup failed');
  const revived = unblockTask(blocked.value);
  if (!revived.ok) throw new Error('fixture setup failed');
  return revived.value;
};

describe('bucketTaskSignals — self-blocked task (trace-only blind spot)', () => {
  it('resolves an own-failure block to `completed` from the trace alone — the defect this module corrects', () => {
    const result = bucketTaskSignals(cleanRunTrace(SELF_BLOCKED), [], []);
    expect(result.tasks[0]?.status).toBe('completed');
  });
});

describe('overlayEntityBlockedStatus', () => {
  it('flips a trace-`completed` bucket to `blocked` when the polled entity says so', () => {
    const bucketed = bucketTaskSignals(cleanRunTrace(SELF_BLOCKED), [], []);
    const todo = makeTodoTask({ name: 'Self-blocked task' });
    const blockedResult = markTaskBlocked(
      { ...todo, id: SELF_BLOCKED as TaskId },
      'budget exhausted after 3 attempts',
      'own'
    );
    if (!blockedResult.ok) throw new Error('fixture setup failed');

    const corrected = overlayEntityBlockedStatus(bucketed, [blockedResult.value]);

    expect(corrected.tasks[0]?.status).toBe('blocked');
    // Nothing else on the bucket is touched — this is a status-only correction.
    expect(corrected.tasks[0]?.subSteps).toEqual(bucketed.tasks[0]?.subSteps);
  });

  it('leaves a genuinely completed task alone when the polled entity confirms it done', () => {
    const bucketed = bucketTaskSignals(cleanRunTrace(SIBLING), [], []);

    const corrected = overlayEntityBlockedStatus(bucketed, [doneEntity(SIBLING)]);

    expect(corrected.tasks[0]?.status).toBe('completed');
    // No task needed correcting — same reference back out (memoization contract).
    expect(corrected).toBe(bucketed);
  });

  it('reads a task the operator unblocked after the run as pending, not completed', () => {
    const bucketed = bucketTaskSignals(cleanRunTrace(SELF_BLOCKED), [], []);

    const corrected = overlayEntityBlockedStatus(bucketed, [revivedEntity(SELF_BLOCKED)]);

    expect(corrected.tasks[0]?.status).toBe('pending');
    // The finished run's duration would read as time spent pending — dropped, like any pending bucket.
    expect(corrected.tasks[0]?.durationMs).toBeUndefined();
    // The session's history of the run it just retired stays on the card.
    expect(corrected.tasks[0]?.subSteps).toEqual(bucketed.tasks[0]?.subSteps);
  });

  it('keeps a just-finished task completed while the polled entity still lags at in_progress', () => {
    const bucketed = bucketTaskSignals(cleanRunTrace(SIBLING), [], []);
    const lagging = { ...makeInProgressTaskWithRunningAttempt(), id: SIBLING as TaskId };

    const corrected = overlayEntityBlockedStatus(bucketed, [lagging]);

    expect(corrected.tasks[0]?.status).toBe('completed');
    expect(corrected).toBe(bucketed);
  });

  it('keeps a completed task completed when the snapshot predates its first attempt', () => {
    // A task fast enough to run start to finish between two polls — the snapshot is still the
    // pre-run `todo`, which is not the shape an unblock leaves behind.
    const bucketed = bucketTaskSignals(cleanRunTrace(SIBLING), [], []);
    const preRun = { ...makeTodoTask({ name: 'Fast task' }), id: SIBLING as TaskId };

    const corrected = overlayEntityBlockedStatus(bucketed, [preRun]);

    expect(corrected.tasks[0]?.status).toBe('completed');
    expect(corrected).toBe(bucketed);
  });

  it('keeps a chain-level aborted verdict for a task the operator unblocked afterwards', () => {
    const abortedTrace: Trace = [{ elementName: `generator-${SELF_BLOCKED}`, status: 'aborted', durationMs: 5 }];
    const bucketed = bucketTaskSignals(abortedTrace, [], []);

    const corrected = overlayEntityBlockedStatus(bucketed, [revivedEntity(SELF_BLOCKED)]);

    expect(corrected.tasks[0]?.status).toBe('aborted');
    expect(corrected).toBe(bucketed);
  });

  it('never regresses a chain-level failed/aborted substep, even if the entity also reads blocked', () => {
    const failedTrace: Trace = [{ elementName: `generator-${SELF_BLOCKED}`, status: 'failed', durationMs: 5 }];
    const bucketed = bucketTaskSignals(failedTrace, [], []);
    const todo = makeTodoTask({ name: 'Self-blocked task' });
    const blockedResult = markTaskBlocked({ ...todo, id: SELF_BLOCKED as TaskId }, 'crashed', 'own');
    if (!blockedResult.ok) throw new Error('fixture setup failed');

    const corrected = overlayEntityBlockedStatus(bucketed, [blockedResult.value]);

    expect(corrected.tasks[0]?.status).toBe('failed');
  });

  it('does not touch a bucket the dependency gate already marked blocked (idempotent)', () => {
    const gateTrace: Trace = [
      { elementName: `dependency-gate-${SELF_BLOCKED}`, status: 'completed', durationMs: 2 },
      { elementName: `task-body-${SELF_BLOCKED}`, status: 'skipped', durationMs: 0 },
    ];
    const bucketed = bucketTaskSignals(gateTrace, [], []);
    const todo = makeTodoTask({ name: 'Upstream blocked task' });
    const blockedResult = markTaskBlocked({ ...todo, id: SELF_BLOCKED as TaskId }, 'blocked upstream', 'upstream');
    if (!blockedResult.ok) throw new Error('fixture setup failed');

    const corrected = overlayEntityBlockedStatus(bucketed, [blockedResult.value]);

    expect(corrected.tasks[0]?.status).toBe('blocked');
    expect(corrected).toBe(bucketed);
  });

  it('returns the same reference when taskState is undefined or empty', () => {
    const bucketed = bucketTaskSignals(cleanRunTrace(SELF_BLOCKED), [], []);
    expect(overlayEntityBlockedStatus(bucketed, undefined)).toBe(bucketed);
    expect(overlayEntityBlockedStatus(bucketed, [])).toBe(bucketed);
  });

  it('corrects only the sibling that is actually blocked, in a run with several tasks', () => {
    const trace: Trace = [...cleanRunTrace(SELF_BLOCKED), ...cleanRunTrace(SIBLING)];
    const bucketed = bucketTaskSignals(trace, [], []);
    const todo = makeTodoTask({ name: 'Self-blocked task' });
    const blockedResult = markTaskBlocked({ ...todo, id: SELF_BLOCKED as TaskId }, 'budget exhausted', 'own');
    if (!blockedResult.ok) throw new Error('fixture setup failed');

    const corrected = overlayEntityBlockedStatus(bucketed, [blockedResult.value, doneEntity(SIBLING)]);

    const byId = new Map(corrected.tasks.map((t) => [t.id, t.status]));
    expect(byId.get(SELF_BLOCKED)).toBe('blocked');
    expect(byId.get(SIBLING)).toBe('completed');
  });
});
