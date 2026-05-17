import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { absolutePath, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createProjectUseCase } from '@src/business/project/create-project.ts';

const okSave: Save<Project> = {
  async save() {
    return Result.ok(undefined);
  },
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
    const failing: Save<Project> = {
      async save() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk dead' }));
      },
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
    const repo: Save<Project> = {
      async save(p) {
        saved = p;
        return Result.ok(undefined);
      },
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
});
