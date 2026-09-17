/**
 * A CASCADE dependent — a task blocked only because its prerequisite never finished, not on its own
 * merits — is cleared by `unblockTask` the same way an own-failure block is: back to `todo` with an
 * empty attempt ledger. But it never had an attempt of its own, so `hasArchivableState` never
 * archives a `RetiredRun` for it (see `task-lifecycle.ts`). That leaves it with `retiredAttempts`
 * still empty, which `isRevivedAfterRun` requires to be non-empty before it will reconcile a
 * trace-frozen `blocked` bucket back to `pending`. Without a distinct check for this shape, a
 * cascade-cleared dependent stays rendered `blocked`/red forever after the operator unblocks its
 * root task, until a brand-new run re-traces that task id.
 */

import { describe, expect, it } from 'vitest';
import type { Trace } from '@src/application/chain/trace.ts';
import { bucketTaskSignals, overlayEntityBlockedStatus } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked, unblockTask } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const DEPENDENT = '01933fbb-3333-7000-8000-000000000003';
const ROOT = '01933fbb-4444-7000-8000-000000000004';

/** The exact trace shape the dependency gate + body guard produce for a blocked task. */
const gateBlockedTrace = (taskId: string): Trace => [
  { elementName: `dependency-gate-${taskId}`, status: 'completed', durationMs: 2 },
  { elementName: `task-body-${taskId}`, status: 'skipped', durationMs: 0 },
];

/** The exact trace shape an own-failure block produces: every substep completed. */
const cleanRunTrace = (taskId: string): Trace => [
  { elementName: `dependency-gate-${taskId}`, status: 'completed', durationMs: 2 },
  { elementName: `generator-${taskId}`, status: 'completed', durationMs: 40 },
  { elementName: `commit-task-${taskId}`, status: 'completed', durationMs: 5 },
  { elementName: `uninstall-skills-${taskId}`, status: 'completed', durationMs: 3 },
];

/** The polled entity before the cascade ran — blocked upstream, zero attempts of its own. */
const preUnblockDependent = (id: string): Task => {
  const todo = makeTodoTask({ name: 'Dependent task' });
  const blocked = markTaskBlocked({ ...todo, id: id as TaskId }, 'blocked upstream', 'upstream');
  if (!blocked.ok) throw new Error('fixture setup failed');
  return blocked.value;
};

/**
 * The polled entity after `unblockTaskUseCase`'s cascade ran `unblockTask` on it — the EXACT
 * transformation `persistCascade` applies to every upstream dependent. `hasArchivableState` is
 * false (no attempts, no verdicts, no escalation), so `retiredAttempts` stays empty/undefined.
 */
const postUnblockDependent = (id: string): Task => {
  const revived = unblockTask(preUnblockDependent(id));
  if (!revived.ok) throw new Error('fixture setup failed');
  return revived.value;
};

/** An own-failure-blocked root WITH a real attempt, so its unblock DOES archive a retiredAttempts entry. */
const preUnblockRoot = (id: string): Task => {
  const inProgress = makeInProgressTaskWithRunningAttempt();
  const blocked = markTaskBlocked({ ...inProgress, id: id as TaskId }, 'budget exhausted', 'own');
  if (!blocked.ok) throw new Error('fixture setup failed');
  return blocked.value;
};

const postUnblockRoot = (id: string): Task => {
  const revived = unblockTask(preUnblockRoot(id));
  if (!revived.ok) throw new Error('fixture setup failed');
  return revived.value;
};

describe('overlayEntityBlockedStatus — cascade-cleared dependent', () => {
  it('leaves the bucket blocked when the entity is still upstream-blocked (regression guard)', () => {
    const bucketed = bucketTaskSignals(gateBlockedTrace(DEPENDENT), [], []);

    const corrected = overlayEntityBlockedStatus(bucketed, [preUnblockDependent(DEPENDENT)], false);

    expect(corrected.tasks[0]?.status).toBe('blocked');
    expect(corrected).toBe(bucketed);
  });

  it('reconciles a cascade-cleared dependent to pending once the run has settled', () => {
    const bucketed = bucketTaskSignals(gateBlockedTrace(DEPENDENT), [], []);

    const corrected = overlayEntityBlockedStatus(bucketed, [postUnblockDependent(DEPENDENT)], false);

    expect(corrected.tasks[0]?.status).toBe('pending');
    // The run history (the gate + skipped body) stays visible on the card.
    expect(corrected.tasks[0]?.subSteps).toEqual(bucketed.tasks[0]?.subSteps);
  });

  it('keeps a cascade-cleared dependent blocked while a run is still live (poll-lag guard)', () => {
    const bucketed = bucketTaskSignals(gateBlockedTrace(DEPENDENT), [], []);

    const corrected = overlayEntityBlockedStatus(bucketed, [postUnblockDependent(DEPENDENT)], true);

    expect(corrected.tasks[0]?.status).toBe('blocked');
    expect(corrected).toBe(bucketed);
  });

  it('reconciles both an own-failure root and its cascade dependent to pending after settling', () => {
    const trace: Trace = [...cleanRunTrace(ROOT), ...gateBlockedTrace(DEPENDENT)];
    const bucketed = bucketTaskSignals(trace, [], []);

    const corrected = overlayEntityBlockedStatus(
      bucketed,
      [postUnblockRoot(ROOT), postUnblockDependent(DEPENDENT)],
      false
    );

    const byId = new Map(corrected.tasks.map((t) => [t.id, t.status]));
    expect(byId.get(ROOT)).toBe('pending');
    expect(byId.get(DEPENDENT)).toBe('pending');
  });
});
