import { describe, expect, it } from 'vitest';

import { InMemorySprintRepository } from '../../../business/_test-fakes/in-memory-sprint-repository.ts';
import { makeSprint } from '../../_test-fakes/fixtures.ts';
import { loadSprintLeaf, type LoadSprintCtx } from './load-sprint.ts';

describe('loadSprintLeaf', () => {
  it('loads a sprint by id and writes it onto the context', async () => {
    const sprint = makeSprint();
    const repo = new InMemorySprintRepository([sprint]);
    const leaf = loadSprintLeaf<LoadSprintCtx>({ sprintRepo: repo });

    const result = await leaf.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.sprint?.id).toBe(sprint.id);
    expect(result.value.trace).toHaveLength(1);
    expect(result.value.trace[0]?.stepName).toBe('load-sprint');
    expect(result.value.trace[0]?.status).toBe('completed');
  });

  it('surfaces NotFoundError when the sprint id is unknown', async () => {
    const sprint = makeSprint();
    const repo = new InMemorySprintRepository();
    const leaf = loadSprintLeaf<LoadSprintCtx>({ sprintRepo: repo });

    const result = await leaf.execute({ sprintId: sprint.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('not-found');
    expect(result.error.trace[0]?.status).toBe('failed');
  });
});
