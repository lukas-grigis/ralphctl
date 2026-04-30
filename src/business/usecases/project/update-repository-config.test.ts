import { describe, expect, it } from 'vitest';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { InMemoryProjectRepository } from '../../_test-fakes/in-memory-project-repository.ts';
import { UpdateRepositoryConfigUseCase } from './update-repository-config.ts';

function projectName(name: string): ProjectName {
  const r = ProjectName.parse(name);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectWithOneRepo(): Project {
  const repoR = Repository.create({ path: path('/abs/r') });
  if (!repoR.ok) throw new Error('precondition failed');
  const r = Project.create({
    name: projectName('demo'),
    displayName: 'Demo',
    repositories: [repoR.value],
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('UpdateRepositoryConfigUseCase', () => {
  it('updates the checkScript', async () => {
    const proj = projectWithOneRepo();
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new UpdateRepositoryConfigUseCase(repoStore);

    const result = await uc.execute({
      projectName: proj.name,
      path: path('/abs/r'),
      partial: { checkScript: 'pnpm test' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repositories[0]?.checkScript).toBe('pnpm test');
  });

  it('updates the name and checkTimeout together', async () => {
    const proj = projectWithOneRepo();
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new UpdateRepositoryConfigUseCase(repoStore);

    const result = await uc.execute({
      projectName: proj.name,
      path: path('/abs/r'),
      partial: { name: 'renamed', checkTimeout: 60_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repositories[0]?.name).toBe('renamed');
    expect(result.value.repositories[0]?.checkTimeout).toBe(60_000);
  });

  it('returns ValidationError on invalid checkTimeout', async () => {
    const proj = projectWithOneRepo();
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new UpdateRepositoryConfigUseCase(repoStore);

    const result = await uc.execute({
      projectName: proj.name,
      path: path('/abs/r'),
      partial: { checkTimeout: -5 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('returns ValidationError when the repo path is not on the project', async () => {
    const proj = projectWithOneRepo();
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new UpdateRepositoryConfigUseCase(repoStore);

    const result = await uc.execute({
      projectName: proj.name,
      path: path('/abs/missing'),
      partial: { checkScript: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('returns NotFoundError when project name unknown', async () => {
    const repoStore = new InMemoryProjectRepository();
    const uc = new UpdateRepositoryConfigUseCase(repoStore);

    const result = await uc.execute({
      projectName: projectName('missing'),
      path: path('/abs/x'),
      partial: { checkScript: 'x' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
