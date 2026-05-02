import { describe, expect, it } from 'vitest';

import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import { makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { saveTasksLeaf, type SaveTasksCtx } from './save-tasks.ts';

describe('saveTasksLeaf', () => {
  it('replaces the task list for a sprint via saveAll', async () => {
    const sprint = makeSprint();
    const repo = new InMemoryTaskRepository();
    const leaf = saveTasksLeaf<SaveTasksCtx>({ taskRepo: repo });
    const tasks = [makeTask({ name: 'one' })];

    const result = await leaf.execute({ sprintId: sprint.id, tasks });
    expect(result.ok).toBe(true);

    const reread = await repo.findBySprintId(sprint.id);
    if (!reread.ok) throw new Error('expected tasks');
    expect(reread.value.map((t) => t.name)).toStrictEqual(['one']);
  });

  it('fails the step when ctx.tasks is missing', async () => {
    const sprint = makeSprint();
    const repo = new InMemoryTaskRepository();
    const leaf = saveTasksLeaf<SaveTasksCtx>({ taskRepo: repo });

    const result = await leaf.execute({ sprintId: sprint.id });
    expect(result.ok).toBe(false);
  });
});
