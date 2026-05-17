import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { activateSprintUseCase } from '@src/business/sprint/activate-sprint.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import {
  FIXED_LATEST,
  makeActiveSprint,
  makePlannedSprint,
  makeReviewSprint,
  projectId,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

type SprintRepoDouble = Save<Sprint> & ListAll<Sprint>;

const repoOf = (sprints: Sprint[]): SprintRepoDouble & { readonly saved: Sprint[] } => {
  const saved: Sprint[] = [];
  return {
    saved,
    async save(s) {
      saved.push(s);
      return Result.ok(undefined);
    },
    async list() {
      return Result.ok(sprints);
    },
  };
};

describe('activateSprintUseCase', () => {
  it('transitions planned → active and persists', async () => {
    const planned = makePlannedSprint();
    const repo = repoOf([planned]);

    const result = await activateSprintUseCase({
      sprint: planned,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('active');
    expect(repo.saved).toHaveLength(1);
  });

  it('idempotent — an already-active sprint passes through without re-saving', async () => {
    const active = makeActiveSprint();
    const repo = repoOf([active]);

    const result = await activateSprintUseCase({
      sprint: active,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('active');
    expect(repo.saved).toHaveLength(0);
  });

  it('rejects with ConflictError when another sprint in the same project is already active', async () => {
    const active = makeActiveSprint();
    const planned = makePlannedSprint();
    const repo = repoOf([active, planned]);

    const result = await activateSprintUseCase({
      sprint: planned,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      expect(result.error.message).toContain(String(active.slug));
      expect(result.error.message).toContain('active');
    }
    expect(repo.saved).toHaveLength(0);
  });

  it('rejects with ConflictError when another sprint in the same project is in review', async () => {
    const review = makeReviewSprint();
    const planned = makePlannedSprint();
    const repo = repoOf([review, planned]);

    const result = await activateSprintUseCase({
      sprint: planned,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      expect(result.error.message).toContain('review');
    }
  });

  it('allows activation when the only active sprint belongs to a different project', async () => {
    const otherProjectActive = makeActiveSprint();
    const planned = makePlannedSprint();
    const repoSprints: Sprint[] = [
      { ...otherProjectActive, projectId: projectId('01900000-0000-7000-8000-0000000000aa') },
      planned,
    ];
    const repo = repoOf(repoSprints);

    const result = await activateSprintUseCase({
      sprint: planned,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('active');
  });

  it('propagates StorageError when the repository list call fails', async () => {
    const planned = makePlannedSprint();
    const failingRepo: SprintRepoDouble = {
      async save() {
        return Result.ok(undefined);
      },
      async list() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'sprints' }));
      },
    };

    const result = await activateSprintUseCase({
      sprint: planned,
      sprintRepo: failingRepo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage-error');
  });
});
