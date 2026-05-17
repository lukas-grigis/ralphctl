import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { removeRepositoryUseCase } from '@src/business/project/remove-repository.ts';

const okSave: Save<Project> = {
  async save() {
    return Result.ok(undefined);
  },
};

const REPO_ID_A = ((): RepositoryId => {
  const r = RepositoryId.parse('01900000-0000-7000-8000-000000000aaa');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();
const REPO_ID_B = ((): RepositoryId => {
  const r = RepositoryId.parse('01900000-0000-7000-8000-000000000bbb');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

describe('removeRepositoryUseCase', () => {
  it('removes a repository when more than one exists', async () => {
    const r1 = makeRepository({ id: REPO_ID_A, slug: 'one', path: '/tmp/one' });
    const r2 = makeRepository({ id: REPO_ID_B, slug: 'two', path: '/tmp/two' });
    const project = makeProject({ repositories: [r1, r2] });
    const result = await removeRepositoryUseCase({
      project,
      repositoryId: r1.id,
      projectRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repositories).toHaveLength(1);
      expect(result.value.repositories[0]?.id).toBe(r2.id);
    }
  });

  it('rejects removing the last repository (domain invariant)', async () => {
    const r1 = makeRepository();
    const project = makeProject({ repositories: [r1] });
    const result = await removeRepositoryUseCase({
      project,
      repositoryId: r1.id,
      projectRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects removing an unknown repository id', async () => {
    const project = makeProject();
    const result = await removeRepositoryUseCase({
      project,
      repositoryId: 'unknown-id' as RepositoryId,
      projectRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
  });
});
