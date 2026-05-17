import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { type SaveProjectCtx, saveProjectLeaf } from '@src/application/flows/_shared/project/save.ts';

const fakeRepo = (opts: { failSave?: StorageError } = {}): { repo: ProjectRepository; saved: Project[] } => {
  const saved: Project[] = [];
  const repo = {
    async save(project: Project) {
      if (opts.failSave) return Result.error(opts.failSave);
      saved.push(project);
      return Result.ok(undefined);
    },
  } as ProjectRepository;
  return { repo, saved };
};

describe('saveProjectLeaf', () => {
  it('persists ctx.project and returns ctx unchanged', async () => {
    const project = makeProject();
    const { repo, saved } = fakeRepo();
    const el = saveProjectLeaf<SaveProjectCtx>({ projectRepo: repo });

    const result = await el.execute({ project });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx).toEqual({ project });
      expect(result.value.trace[0]?.status).toBe('completed');
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]).toBe(project);
  });

  it('surfaces a storage error as a failed trace entry', async () => {
    const project = makeProject();
    const failure = new StorageError({ subCode: 'io', message: 'disk full' });
    const { repo } = fakeRepo({ failSave: failure });
    const el = saveProjectLeaf<SaveProjectCtx>({ projectRepo: repo });

    const result = await el.execute({ project });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe(failure);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('surfaces a missing-project precondition as a failed trace entry (chain wiring error)', async () => {
    const { repo } = fakeRepo();
    const el = saveProjectLeaf<SaveProjectCtx>({ projectRepo: repo });

    const result = await el.execute({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(InvalidStateError);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });
});
