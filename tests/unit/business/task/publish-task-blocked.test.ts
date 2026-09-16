import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { publishingBlockedWrites, publishTaskBlocked } from '@src/business/task/publish-task-blocked.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { FIXED_LATER, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';

const SPRINT_ID = 'sprint-x' as SprintId;

const capturingBus = (): { bus: EventBus; events: AppEvent[] } => {
  const events: AppEvent[] = [];
  return { events, bus: { publish: (e) => events.push(e), subscribe: () => () => {} } };
};

const blockedTask = (reason: string, kind: BlockedTask['blockKind'] = 'own'): BlockedTask => {
  const blocked = markTaskBlocked(makeTodoTask({ name: 'wire the thing' }), reason, kind);
  if (!blocked.ok) throw blocked.error;
  return blocked.value;
};

const fakeRepo = (result: Awaited<ReturnType<UpdateTask['update']>> = Result.ok(undefined)) => {
  const calls: Task[] = [];
  const repo: UpdateTask = {
    async update(_sprintId, task) {
      calls.push(task);
      return result;
    },
  };
  return { repo, calls };
};

describe('publishTaskBlocked', () => {
  it('publishes one task-blocked event carrying the first line of the reason', () => {
    const { bus, events } = capturingBus();
    const task = blockedTask('fold conflict — could not land\nRejected diff quarantined to git stash: x', 'own');

    publishTaskBlocked(bus, task, FIXED_LATER);

    expect(events).toStrictEqual([
      {
        type: 'task-blocked',
        taskId: String(task.id),
        taskName: 'wire the thing',
        blockKind: 'own',
        reason: 'fold conflict — could not land',
        at: FIXED_LATER,
      },
    ]);
  });

  it('strips control characters and clamps both text fields', () => {
    const esc = String.fromCharCode(0x1b);
    const { bus, events } = capturingBus();
    const task = blockedTask(`${esc}]0;pwned${esc}\\${'x'.repeat(500)}`);

    publishTaskBlocked(bus, task, FIXED_LATER);

    const event = events[0];
    if (event?.type !== 'task-blocked') throw new Error('expected a task-blocked event');
    expect(event.reason).not.toContain(esc);
    expect(event.reason).toHaveLength(200);
    expect(event.reason.endsWith('…')).toBe(true);
  });

  it('carries the upstream block kind through unchanged', () => {
    const { bus, events } = capturingBus();
    publishTaskBlocked(
      bus,
      blockedTask('blocked upstream — prerequisite not done: a (blocked)', 'upstream'),
      FIXED_LATER
    );
    expect(events[0]).toMatchObject({ type: 'task-blocked', blockKind: 'upstream' });
  });
});

describe('publishingBlockedWrites', () => {
  it('publishes once after a blocked task is persisted, stamped with the clock', async () => {
    const { bus, events } = capturingBus();
    const { repo, calls } = fakeRepo();
    const task = blockedTask('attempt budget exhausted');

    const result = await publishingBlockedWrites(repo, bus, () => FIXED_LATER).update(SPRINT_ID, task);

    expect(result.ok).toBe(true);
    expect(calls).toStrictEqual([task]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'task-blocked', taskId: String(task.id), at: FIXED_LATER });
  });

  it('stays silent for a non-blocked write', async () => {
    const { bus, events } = capturingBus();
    const { repo, calls } = fakeRepo();

    const result = await publishingBlockedWrites(repo, bus, () => FIXED_LATER).update(
      SPRINT_ID,
      makeInProgressTaskWithRunningAttempt()
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('stays silent when the write fails, and returns the failure unchanged', async () => {
    const { bus, events } = capturingBus();
    const failure = new StorageError({ subCode: 'io', message: 'disk full' });
    const { repo } = fakeRepo(Result.error(failure));

    const result = await publishingBlockedWrites(repo, bus, () => FIXED_LATER).update(
      SPRINT_ID,
      blockedTask('attempt budget exhausted')
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(failure);
    expect(events).toHaveLength(0);
  });
});
