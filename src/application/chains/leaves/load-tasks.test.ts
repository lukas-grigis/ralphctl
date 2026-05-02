import { describe, expect, it } from 'vitest';

import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import { makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { loadTasksLeaf, type LoadTasksCtx } from './load-tasks.ts';

describe('loadTasksLeaf', () => {
  it('reads the task list for a sprint and writes it onto the context', async () => {
    const sprint = makeSprint();
    const t1 = makeTask({ name: 'one', order: 1 });
    const t2 = makeTask({ name: 'two', order: 2 });
    const repo = new InMemoryTaskRepository([[sprint.id, [t1, t2]]]);
    const leaf = loadTasksLeaf<LoadTasksCtx>({ taskRepo: repo });

    const result = await leaf.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tasks?.map((t) => t.name)).toStrictEqual(['one', 'two']);
  });

  it('returns an empty list (not a domain error) for sprints without tasks', async () => {
    const sprint = makeSprint();
    const repo = new InMemoryTaskRepository();
    const leaf = loadTasksLeaf<LoadTasksCtx>({ taskRepo: repo });

    const result = await leaf.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tasks).toStrictEqual([]);
  });
});
