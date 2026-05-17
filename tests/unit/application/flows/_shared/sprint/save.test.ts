import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';
import { type SaveSprintCtx, saveSprintLeaf } from '@src/application/flows/_shared/sprint/save.ts';

const fakeRepo = (opts: { failSave?: StorageError } = {}): { repo: SprintRepository; saved: Sprint[] } => {
  const saved: Sprint[] = [];
  const repo = {
    async save(sprint: Sprint) {
      if (opts.failSave) return Result.error(opts.failSave);
      saved.push(sprint);
      return Result.ok(undefined);
    },
  } as SprintRepository;
  return { repo, saved };
};

describe('saveSprintLeaf', () => {
  it('persists ctx.sprint and returns ctx unchanged', async () => {
    const sprint = makeDraftSprint();
    const { repo, saved } = fakeRepo();
    const el = saveSprintLeaf<SaveSprintCtx>({ sprintRepo: repo });

    const result = await el.execute({ sprint });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ sprint });
      expect(result.value.trace[0]?.status).toBe('completed');
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]).toBe(sprint);
  });

  it('surfaces a storage error as a failed trace entry', async () => {
    const sprint = makeDraftSprint();
    const failure = new StorageError({ subCode: 'io', message: 'disk full' });
    const { repo } = fakeRepo({ failSave: failure });
    const el = saveSprintLeaf<SaveSprintCtx>({ sprintRepo: repo });

    const result = await el.execute({ sprint });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(failure);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('surfaces a missing-sprint precondition as a failed trace entry (chain wiring error)', async () => {
    const { repo } = fakeRepo();
    const el = saveSprintLeaf<SaveSprintCtx>({ sprintRepo: repo });

    const result = await el.execute({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });
});
