import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { reopenDoneSprintUseCase } from '@src/business/sprint/reopen-sprint.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ListAll } from '@src/domain/repository/_base/list-all.ts';
import type { Save } from '@src/domain/repository/_base/save.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { FIXED_LATEST, makeActiveSprint, makeDoneSprint, makeReviewSprint, projectId } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

type SprintRepoDouble = Save<Sprint> & ListAll<Sprint> & { readonly saved: Sprint[] };

/** `peers` defaults to `[]` — most tests care only about the sprint under transition, and an
 *  empty peer list trivially satisfies the single-active-per-project check. */
const repoOk = (peers: readonly Sprint[] = []): SprintRepoDouble => {
  const saved: Sprint[] = [];
  return {
    saved,
    async save(s) {
      saved.push(s);
      return Result.ok(undefined);
    },
    async list() {
      return Result.ok(peers);
    },
  };
};

describe('reopenDoneSprintUseCase', () => {
  it('transitions done → review and persists', async () => {
    const done = makeDoneSprint();
    const repo = repoOk();

    const result = await reopenDoneSprintUseCase({
      sprint: done,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('review');
    expect(result.value.doneAt).toBeNull();
    expect(result.value.reviewAt).toBe(FIXED_LATEST);
    expect(repo.saved).toHaveLength(1);
  });

  it('idempotent — an already-review sprint passes through without re-saving', async () => {
    const review = makeReviewSprint();
    const repo = repoOk();

    const result = await reopenDoneSprintUseCase({
      sprint: review,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('review');
    expect(repo.saved).toHaveLength(0);
  });

  it('rejects a sprint that is neither done nor review with InvalidStateError', async () => {
    const active = makeActiveSprint();
    const repo = repoOk();

    const result = await reopenDoneSprintUseCase({
      sprint: active,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(repo.saved).toHaveLength(0);
  });

  it('propagates StorageError when persistence fails', async () => {
    const done = makeDoneSprint();
    const failingRepo: Save<Sprint> & ListAll<Sprint> = {
      async save() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'sprint' }));
      },
      async list() {
        return Result.ok([]);
      },
    };

    const result = await reopenDoneSprintUseCase({
      sprint: done,
      sprintRepo: failingRepo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
  });

  it('propagates StorageError when the repository list call (the peer check) fails', async () => {
    const done = makeDoneSprint();
    const failingListRepo: Save<Sprint> & ListAll<Sprint> = {
      async save() {
        return Result.ok(undefined);
      },
      async list() {
        return Result.error(new StorageError({ subCode: 'io', message: 'disk full', path: 'sprints' }));
      },
    };

    const result = await reopenDoneSprintUseCase({
      sprint: done,
      sprintRepo: failingListRepo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('storage-error');
  });

  // Single-active-per-project invariant (mirrors activateSprintUseCase's own peer check):
  // `done` released the project, so without this guard a peer already `active` could end up
  // sharing the project with the sprint being reopened back into `review` — and the two would
  // not mutually exclude on the shared working tree (the repo lock is keyed per sprint dir, not
  // per project).
  it('rejects with ConflictError when another sprint in the same project is already active', async () => {
    const done = makeDoneSprint();
    const activePeer = makeActiveSprint();
    const repo = repoOk([done, activePeer]);

    const result = await reopenDoneSprintUseCase({
      sprint: done,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      expect(result.error.message).toContain(String(activePeer.slug));
      expect(result.error.message).toContain('active');
    }
    expect(repo.saved).toHaveLength(0);
  });

  it('allows reopening when the only active sprint belongs to a different project', async () => {
    const done = makeDoneSprint();
    const otherProjectActive = makeActiveSprint();
    const repoSprints: Sprint[] = [
      done,
      { ...otherProjectActive, projectId: projectId('01900000-0000-7000-8000-0000000000aa') },
    ];
    const repo = repoOk(repoSprints);

    const result = await reopenDoneSprintUseCase({
      sprint: done,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('review');
  });

  it('an already-review sprint short-circuits before the peer check even runs', async () => {
    const review = makeReviewSprint();
    const activePeer = makeActiveSprint();
    const repo = repoOk([review, activePeer]);

    const result = await reopenDoneSprintUseCase({
      sprint: review,
      sprintRepo: repo,
      clock: () => FIXED_LATEST,
      logger: noopLogger,
    });

    // Idempotent pass-through wins even though a peer would otherwise conflict — mirrors
    // activateSprintUseCase's own already-active short-circuit ordering.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('review');
  });
});
