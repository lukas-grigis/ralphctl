import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeDoneTask, makeTodoTask } from '@tests/fixtures/domain.ts';
import { dependencyGateLeaf, isTaskRunnable } from '@src/application/flows/implement/leaves/dependency-gate.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

const sprintId = ((): ImplementCtx['sprintId'] => {
  const r = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const fakeRepo = (): UpdateTask & { calls: number } => ({
  calls: 0,
  async update() {
    (this as unknown as { calls: number }).calls += 1;
    return Result.ok(undefined);
  },
});

const blockedTask = (name: string): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask({ name }), 'prior failure', 'upstream');
  if (!r.ok) throw r.error;
  return r.value;
};

describe('dependencyGateLeaf', () => {
  it('blocks a dependent upstream when a prerequisite is blocked, and the body guard then skips it', async () => {
    const a = blockedTask('A');
    const b = makeTodoTask({ name: 'B', dependsOn: [a.id] });
    const repo = fakeRepo();
    const ctx: ImplementCtx = { sprintId, tasks: [a, b] };

    const res = await dependencyGateLeaf({ taskRepo: repo, logger: noopLogger }, b.id).execute(ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const updatedB = res.value.ctx.tasks?.find((t) => t.id === b.id);
    expect(updatedB?.status).toBe('blocked');
    expect((updatedB as BlockedTask).blockedReason).toMatch(/blocked upstream/i);
    expect(repo.calls).toBe(1); // persisted exactly once
    // The body guard reads this — false means the attempt loop (and its AI spawn) is skipped.
    expect(isTaskRunnable(res.value.ctx, b.id)).toBe(false);
  });

  it('cascades transitively: a dependent of an upstream-blocked task is also blocked', async () => {
    const a = blockedTask('A');
    const b = makeTodoTask({ name: 'B', dependsOn: [a.id] });
    const repo = fakeRepo();
    // First gate B (becomes blocked-upstream)…
    const afterB = await dependencyGateLeaf({ taskRepo: repo, logger: noopLogger }, b.id).execute({
      sprintId,
      tasks: [a, b],
    });
    expect(afterB.ok).toBe(true);
    if (!afterB.ok) return;
    // …then C (depends on B) sees B blocked and blocks too.
    const c = makeTodoTask({ name: 'C', dependsOn: [b.id] });
    const ctxWithBlockedB: ImplementCtx = {
      sprintId,
      tasks: [...(afterB.value.ctx.tasks ?? []), c],
    };
    const afterC = await dependencyGateLeaf({ taskRepo: repo, logger: noopLogger }, c.id).execute(ctxWithBlockedB);
    expect(afterC.ok).toBe(true);
    if (!afterC.ok) return;
    expect(afterC.value.ctx.tasks?.find((t) => t.id === c.id)?.status).toBe('blocked');
  });

  it('is a no-op when every prerequisite is done (task stays runnable)', async () => {
    const a = makeDoneTask({ name: 'A' });
    const b = makeTodoTask({ name: 'B', dependsOn: [a.id] });
    const repo = fakeRepo();
    const ctx: ImplementCtx = { sprintId, tasks: [a, b] };

    const res = await dependencyGateLeaf({ taskRepo: repo, logger: noopLogger }, b.id).execute(ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.ctx.tasks?.find((t) => t.id === b.id)?.status).toBe('todo');
    expect(repo.calls).toBe(0); // no write on the happy path
    expect(isTaskRunnable(res.value.ctx, b.id)).toBe(true);
  });

  it('is a no-op for a task with no dependencies', async () => {
    const b = makeTodoTask({ name: 'B' });
    const repo = fakeRepo();
    const res = await dependencyGateLeaf({ taskRepo: repo, logger: noopLogger }, b.id).execute({
      sprintId,
      tasks: [b],
    });
    expect(res.ok).toBe(true);
    expect(repo.calls).toBe(0);
  });

  it('is idempotent on a relaunch re-entering an already-blocked task (no re-write)', async () => {
    const a = blockedTask('A');
    const bBlocked = blockedTask('B'); // already blocked from a prior run
    const repo = fakeRepo();
    const res = await dependencyGateLeaf({ taskRepo: repo, logger: noopLogger }, bBlocked.id).execute({
      sprintId,
      tasks: [a, bBlocked],
    });
    expect(res.ok).toBe(true);
    expect(repo.calls).toBe(0); // already settled → no-op
  });
});
