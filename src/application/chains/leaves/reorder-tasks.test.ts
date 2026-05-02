import { describe, expect, it } from 'vitest';

import { makeTask, taskId } from '@src/application/_test-fakes/fixtures.ts';
import { reorderTasksLeaf, type ReorderTasksCtx } from './reorder-tasks.ts';

describe('reorderTasksLeaf', () => {
  it('reorders tasks topologically by blockedBy', async () => {
    const a = taskId('aaaaaaaa');
    const b = taskId('bbbbbbbb');
    const c = taskId('cccccccc');
    const tasks = [
      makeTask({ id: c, name: 'c', order: 1, blockedBy: [a, b] }),
      makeTask({ id: b, name: 'b', order: 2, blockedBy: [a] }),
      makeTask({ id: a, name: 'a', order: 3 }),
    ];

    const leaf = reorderTasksLeaf<ReorderTasksCtx>();
    const result = await leaf.execute({ tasks });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tasks?.map((t) => t.name)).toStrictEqual(['a', 'b', 'c']);
  });

  it('surfaces a cycle as a kernel error', async () => {
    const a = taskId('aaaaaaaa');
    const b = taskId('bbbbbbbb');
    const tasks = [
      makeTask({ id: a, name: 'a', order: 1, blockedBy: [b] }),
      makeTask({ id: b, name: 'b', order: 2, blockedBy: [a] }),
    ];
    const leaf = reorderTasksLeaf<ReorderTasksCtx>();
    const result = await leaf.execute({ tasks });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('task-cycle');
  });

  it('surfaces an unknown dep as a kernel error', async () => {
    const a = taskId('aaaaaaaa');
    const ghost = taskId('ffffffff');
    const tasks = [makeTask({ id: a, name: 'a', order: 1, blockedBy: [ghost] })];
    const leaf = reorderTasksLeaf<ReorderTasksCtx>();
    const result = await leaf.execute({ tasks });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('task-unknown-dep');
  });
});
