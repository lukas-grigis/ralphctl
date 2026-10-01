import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { absolutePath, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createProjectUseCase } from '@src/business/project/create-project.ts';

type ProjectStore = Save<Project> & ListAll<Project>;

const emptyList = async (): Promise<Result<readonly Project[], StorageError>> => Result.ok([]);

const okSave: ProjectStore = {
  async save() {
    return Result.ok(undefined);
  },
  list: emptyList,
};

describe('createProjectUseCase', () => {
  it('creates and persists a project', async () => {
    const repo = makeRepository({ path: '/tmp/r' });
    const result = await createProjectUseCase({
      input: { displayName: 'demo', repositories: [repo] },
      projectRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.displayName).toBe('demo');
      expect(result.value.repositories).toHaveLength(1);
    }
  });

  it('forwards ValidationError when displayName is empty', async () => {
    const repo = makeRepository({ path: '/tmp/r' });
    const result = await createProjectUseCase({
      input: { displayName: '   ', repositories: [repo] },
      projectRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('forwards StorageError on save failure', async () => {
    const failing: ProjectStore = {
      async save() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk dead' }));
      },
      list: emptyList,
    };
    const repo = makeRepository({ path: '/tmp/r' });
    const result = await createProjectUseCase({
      input: { displayName: 'demo', repositories: [repo] },
      projectRepo: failing,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(StorageError);
  });

  it('rejects when repositories list is empty (domain invariant)', async () => {
    const result = await createProjectUseCase({
      input: { displayName: 'demo', repositories: [] },
      projectRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
  });

  it('persists the project that domain createProject returned', async () => {
    let saved: Project | undefined;
    const repo: ProjectStore = {
      async save(p) {
        saved = p;
        return Result.ok(undefined);
      },
      list: emptyList,
    };
    const result = await createProjectUseCase({
      input: { displayName: 'kept', repositories: [makeRepository({ path: '/tmp/p' })] },
      projectRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    expect(saved?.displayName).toBe('kept');
    void absolutePath; // imported for symmetry with other tests
  });

  it('rejects a slug another project already holds with a ConflictError and saves nothing', async () => {
    let saves = 0;
    const repo: ProjectStore = {
      async save() {
        saves++;
        return Result.ok(undefined);
      },
      list: async () => Result.ok([makeProject({ slug: 'taken' })]),
    };
    const result = await createProjectUseCase({
      input: { displayName: 'Taken', repositories: [makeRepository({ path: '/tmp/t' })] },
      projectRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
      expect(result.error.message).toContain("slug 'taken' is already used");
    }
    expect(saves).toBe(0);
  });

  it('forwards a StorageError from the uniqueness lookup', async () => {
    const repo: ProjectStore = {
      async save() {
        return Result.ok(undefined);
      },
      list: async () => Result.error(new StorageError({ subCode: 'io', message: 'unreadable' })),
    };
    const result = await createProjectUseCase({
      input: { displayName: 'demo', repositories: [makeRepository({ path: '/tmp/r' })] },
      projectRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(StorageError);
  });
});
