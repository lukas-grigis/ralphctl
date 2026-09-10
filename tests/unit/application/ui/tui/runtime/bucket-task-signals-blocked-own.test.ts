/**
 * A task blocked on its OWN merits (budget exhausted, red post-task-verify, generator self-block)
 * runs its ENTIRE subchain to the terminal `uninstall-skills` leaf with no failed/aborted/skipped
 * substep anywhere — `settleAttemptUseCase` records the block on the task entity and returns
 * `Result.ok` so the chain can continue. `bucketTaskSignals` alone therefore resolves this to
 * `completed`, identical to a genuine pass (see `bucket-task-signals-blocked-dependency.test.ts`
 * for the DIFFERENT case this does catch: an upstream dependency-gate skip).
 *
 * `overlayEntityBlockedStatus` is the correction: it cross-references the polled task entities and
 * stamps `blocked` back onto a bucket the trace alone got wrong.
 */

import { describe, expect, it } from 'vitest';
import type { Trace } from '@src/application/chain/trace.ts';
import { bucketTaskSignals, overlayEntityBlockedStatus } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const SELF_BLOCKED = '01933fbb-1111-7000-8000-000000000001';
const SIBLING = '01933fbb-2222-7000-8000-000000000002';

/** The exact trace shape a task blocked on its own merits produces: every substep completed. */
const cleanRunTrace = (taskId: string): Trace => [
  { elementName: `dependency-gate-${taskId}`, status: 'completed', durationMs: 2 },
  { elementName: `generator-${taskId}`, status: 'completed', durationMs: 40 },
  { elementName: `commit-task-${taskId}`, status: 'completed', durationMs: 5 },
  { elementName: `uninstall-skills-${taskId}`, status: 'completed', durationMs: 3 },
];

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

  it('leaves a genuinely completed task alone when no entity reports it blocked', () => {
    const bucketed = bucketTaskSignals(cleanRunTrace(SIBLING), [], []);
    const todo = makeTodoTask({ name: 'Actually finished' });
    const doneLikeTask = { ...todo, id: SIBLING as TaskId, status: 'todo' as const };

    const corrected = overlayEntityBlockedStatus(bucketed, [doneLikeTask]);

    expect(corrected.tasks[0]?.status).toBe('completed');
    // No task needed correcting — same reference back out (memoization contract).
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
    const siblingTodo = { ...makeTodoTask({ name: 'Fine' }), id: SIBLING as TaskId, status: 'todo' as const };

    const corrected = overlayEntityBlockedStatus(bucketed, [blockedResult.value, siblingTodo]);

    const byId = new Map(corrected.tasks.map((t) => [t.id, t.status]));
    expect(byId.get(SELF_BLOCKED)).toBe('blocked');
    expect(byId.get(SIBLING)).toBe('completed');
  });
});
