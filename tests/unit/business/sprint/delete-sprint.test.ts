import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { deleteSprintUseCase } from '@src/business/sprint/delete-sprint.ts';

describe('deleteSprintUseCase', () => {
  it('removes the sprint and returns ok', async () => {
    let removed: SprintId | undefined;
    const repo: Remove<SprintId> = {
      async remove(id) {
        removed = id;
        return Result.ok(undefined);
      },
    };
    const id = 'sprint-x' as SprintId;
    const result = await deleteSprintUseCase({ id, sprintRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(true);
    expect(removed).toBe(id);
  });

  it('forwards NotFoundError', async () => {
    const repo: Remove<SprintId> = {
      async remove(id) {
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
      },
    };
    const result = await deleteSprintUseCase({
      id: 'unknown' as SprintId,
      sprintRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
  });
});
