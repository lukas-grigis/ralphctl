import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { absolutePath, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { updateRepositoryUseCase } from '@src/business/project/update-repository.ts';

const okSave: Save<Project> = {
  async save() {
    return Result.ok(undefined);
  },
};

describe('updateRepositoryUseCase', () => {
  it('updates a repository field and persists', async () => {
    const r = makeRepository({ name: 'old', path: '/tmp/r' });
    const project = makeProject({ repositories: [r] });
    let saved: Project | undefined;
    const repo: Save<Project> = {
      async save(p) {
        saved = p;
        return Result.ok(undefined);
      },
    };
    const result = await updateRepositoryUseCase({
      project,
      repositoryId: r.id,
      patch: { path: absolutePath('/tmp/new') },
      projectRepo: repo,
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
    expect(String(saved?.repositories[0]?.path)).toBe('/tmp/new');
  });

  it('rejects updating an unknown repository id', async () => {
    const project = makeProject();
    const result = await updateRepositoryUseCase({
      project,
      repositoryId: 'unknown' as RepositoryId,
      patch: { name: 'doesn-not-matter' },
      projectRepo: okSave,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
  });
});
