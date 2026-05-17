import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { listSprintsUseCase } from '@src/business/sprint/list-sprints.ts';

describe('listSprintsUseCase', () => {
  it('returns the sprints from the repo', async () => {
    const sprints = [makeDraftSprint(), makeDraftSprint()];
    const repo: ListAll<Sprint> = {
      async list() {
        return Result.ok(sprints);
      },
    };
    const result = await listSprintsUseCase({ sprintRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it('returns an empty list when no sprints exist', async () => {
    const repo: ListAll<Sprint> = {
      async list() {
        return Result.ok([]);
      },
    };
    const result = await listSprintsUseCase({ sprintRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});
