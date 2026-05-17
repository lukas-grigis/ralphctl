import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { FindById } from '@src/domain/repository/_base/find-by-id.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { FIXED_PROJECT_ID, makeProject } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { findProjectUseCase } from '@src/business/project/find-project.ts';

const okRepo = (project: Project): FindById<Project, ProjectId> => ({
  async findById(id) {
    if (id === project.id) return Result.ok(project);
    return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
  },
});

describe('findProjectUseCase', () => {
  it('returns the project when the id matches', async () => {
    const project = makeProject();
    const result = await findProjectUseCase({ id: FIXED_PROJECT_ID, projectRepo: okRepo(project), logger: noopLogger });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(FIXED_PROJECT_ID);
  });

  it('forwards NotFoundError from the repository', async () => {
    const project = makeProject();
    const otherId = '01900000-0000-7000-8000-000000000099' as ProjectId;
    const result = await findProjectUseCase({ id: otherId, projectRepo: okRepo(project), logger: noopLogger });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundError);
  });

  it('forwards StorageError from the repository', async () => {
    const failing: FindById<Project, ProjectId> = {
      async findById() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk dead' }));
      },
    };
    const result = await findProjectUseCase({ id: FIXED_PROJECT_ID, projectRepo: failing, logger: noopLogger });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(StorageError);
  });
});
