import { describe, expect, it } from 'vitest';

import { InMemorySprintRepository } from '../../../business/_test-fakes/in-memory-sprint-repository.ts';
import { makeSprint } from '../../_test-fakes/fixtures.ts';
import { saveSprintLeaf, type SaveSprintCtx } from './save-sprint.ts';

describe('saveSprintLeaf', () => {
  it('persists ctx.sprint via the repository', async () => {
    const sprint = makeSprint();
    const repo = new InMemorySprintRepository();
    const leaf = saveSprintLeaf<SaveSprintCtx>({ sprintRepo: repo });

    const result = await leaf.execute({ sprint });
    expect(result.ok).toBe(true);

    const reread = await repo.findById(sprint.id);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.id).toBe(sprint.id);
  });

  it('fails the step when ctx.sprint is missing', async () => {
    const repo = new InMemorySprintRepository();
    const leaf = saveSprintLeaf<SaveSprintCtx>({ sprintRepo: repo });

    const result = await leaf.execute({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.trace[0]?.status).toBe('failed');
  });
});
