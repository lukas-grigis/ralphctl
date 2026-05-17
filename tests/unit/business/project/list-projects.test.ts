import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { listProjectsUseCase } from '@src/business/project/list-projects.ts';

describe('listProjectsUseCase', () => {
  it('returns the projects from the repository', async () => {
    const projects = [makeProject(), makeProject({ displayName: 'second' })];
    const repo: ListAll<Project> = {
      async list() {
        return Result.ok(projects);
      },
    };
    const result = await listProjectsUseCase({ projectRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it('returns an empty list when the repository has none', async () => {
    const repo: ListAll<Project> = {
      async list() {
        return Result.ok([]);
      },
    };
    const result = await listProjectsUseCase({ projectRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('forwards StorageError', async () => {
    const repo: ListAll<Project> = {
      async list() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk dead' }));
      },
    };
    const result = await listProjectsUseCase({ projectRepo: repo, logger: noopLogger });
    expect(result.ok).toBe(false);
  });
});
