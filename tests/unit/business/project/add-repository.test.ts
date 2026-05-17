import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ConflictError } from '@src/domain/value/error/conflict-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { absolutePath, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { addRepositoryUseCase } from '@src/business/project/add-repository.ts';

const okSave: Save<Project> = {
  async save() {
    return Result.ok(undefined);
  },
};

describe('addRepositoryUseCase', () => {
  it('appends a new repository to the project and persists', async () => {
    const project = makeProject({ repositories: [makeRepository({ slug: 'main' })] });
    let saved: Project | undefined;
    const repo: Save<Project> = {
      async save(p) {
        saved = p;
        return Result.ok(undefined);
      },
    };
    const result = await addRepositoryUseCase({
      project,
      input: { path: absolutePath('/tmp/extra'), name: 'extra' },
      projectRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    expect(saved?.repositories).toHaveLength(2);
    if (result.ok) expect(result.value.repository.name).toBe('extra');
  });

  it('forwards ConflictError on duplicate slug', async () => {
    const project = makeProject({ repositories: [makeRepository({ slug: 'main', path: '/tmp/a' })] });
    const result = await addRepositoryUseCase({
      project,
      input: { path: absolutePath('/tmp/b'), slug: 'main' as never, name: 'main' },
      projectRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ConflictError);
  });

  void ValidationError;
});
