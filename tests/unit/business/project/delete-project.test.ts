import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Remove } from '@src/domain/repository/_base/remove.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { FIXED_PROJECT_ID } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { deleteProjectUseCase } from '@src/business/project/delete-project.ts';

describe('deleteProjectUseCase', () => {
  it('removes the project via the repo and returns ok', async () => {
    let removed: ProjectId | undefined;
    const repo: Remove<ProjectId> = {
      async remove(id) {
        removed = id;
        return Result.ok(undefined);
      },
    };
    const result = await deleteProjectUseCase({ id: FIXED_PROJECT_ID, projectRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(true);
    expect(removed).toBe(FIXED_PROJECT_ID);
  });

  it('forwards NotFoundError', async () => {
    const repo: Remove<ProjectId> = {
      async remove(id) {
        return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
      },
    };
    const result = await deleteProjectUseCase({ id: FIXED_PROJECT_ID, projectRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundError);
  });

  it('forwards StorageError', async () => {
    const repo: Remove<ProjectId> = {
      async remove() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk dead' }));
      },
    };
    const result = await deleteProjectUseCase({ id: FIXED_PROJECT_ID, projectRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(false);
  });
});
