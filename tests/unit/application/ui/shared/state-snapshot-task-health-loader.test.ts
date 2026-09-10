/**
 * `loadTaskHealthBySprintId` is the one batched-fetch loader behind the Sprints list's and the
 * sprint picker's per-row blocked-task badge — extracted so the two views share one fetch-and-
 * degrade implementation instead of each re-deriving the same `Promise.all` loop.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { loadTaskHealthBySprintId } from '@src/application/ui/shared/state-snapshot.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';

const blockedTask = (): Task => {
  const r = markTaskBlocked(makeTodoTask(), 'stuck', 'own');
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

describe('loadTaskHealthBySprintId', () => {
  it('resolves one TaskHealthCounts entry per sprint, keyed by sprint id', async () => {
    const clean = makeDraftSprint({ name: 'clean' });
    const stuck = makeDraftSprint({ name: 'stuck' });
    const tasksBySprint = new Map<Sprint['id'], readonly Task[]>([
      [clean.id, [makeTodoTask()]],
      [stuck.id, [blockedTask(), blockedTask()]],
    ]);
    const taskRepo = {
      async findBySprintId(sprintId: Sprint['id']) {
        return Result.ok(tasksBySprint.get(sprintId) ?? []);
      },
    } as unknown as TaskRepository;

    const result = await loadTaskHealthBySprintId(taskRepo, [clean, stuck]);

    expect(result.get(clean.id)).toEqual({ blockedTaskCount: 0, upstreamBlockedTaskCount: 0 });
    expect(result.get(stuck.id)).toEqual({ blockedTaskCount: 2, upstreamBlockedTaskCount: 0 });
  });

  it("degrades ONE sprint's failing fetch to zero counts without failing the whole batch", async () => {
    const ok = makeDraftSprint({ name: 'ok' });
    const broken = makeDraftSprint({ name: 'broken' });
    const taskRepo = {
      async findBySprintId(sprintId: Sprint['id']) {
        if (sprintId === broken.id) throw new Error('repo exploded');
        return Result.ok([blockedTask()]);
      },
    } as unknown as TaskRepository;

    const result = await loadTaskHealthBySprintId(taskRepo, [ok, broken]);

    expect(result.get(ok.id)).toEqual({ blockedTaskCount: 1, upstreamBlockedTaskCount: 0 });
    expect(result.get(broken.id)).toEqual({ blockedTaskCount: 0, upstreamBlockedTaskCount: 0 });
  });

  it('lets an AbortError propagate rather than degrading it to zero counts', async () => {
    const aborting = makeDraftSprint({ name: 'aborting' });
    const taskRepo = {
      async findBySprintId() {
        throw new DOMException('cancelled', 'AbortError');
      },
    } as unknown as TaskRepository;

    await expect(loadTaskHealthBySprintId(taskRepo, [aborting])).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves to an empty map for an empty sprint list', async () => {
    const taskRepo = {
      async findBySprintId() {
        return Result.ok([]);
      },
    } as unknown as TaskRepository;

    const result = await loadTaskHealthBySprintId(taskRepo, []);
    expect(result.size).toBe(0);
  });
});
