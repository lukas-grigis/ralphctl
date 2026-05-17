import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { findSprintUseCase } from '@src/business/sprint/find-sprint.ts';

describe('findSprintUseCase', () => {
  it('returns the sprint when the id matches', async () => {
    const sprint = makeDraftSprint();
    const repo: FindById<Sprint, SprintId> = {
      async findById(id) {
        if (id === sprint.id) return Result.ok(sprint);
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      },
    };
    const result = await findSprintUseCase({ id: sprint.id, sprintRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(true);
  });

  it('forwards NotFoundError', async () => {
    const repo: FindById<Sprint, SprintId> = {
      async findById(id) {
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      },
    };
    const result = await findSprintUseCase({ id: 'unknown' as SprintId, sprintRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(false);
  });
});
