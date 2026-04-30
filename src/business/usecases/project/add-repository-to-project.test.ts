import { describe, expect, it } from 'vitest';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { InMemoryProjectRepository } from '../../_test-fakes/in-memory-project-repository.ts';
import { AddRepositoryToProjectUseCase } from './add-repository-to-project.ts';

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
  const repoR = Repository.create({ path: path('/abs/first') });
  if (!repoR.ok) throw new Error('precondition failed');
  const r = Project.create({
    name: projectName('demo'),
    displayName: 'Demo',
    repositories: [repoR.value],
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('AddRepositoryToProjectUseCase', () => {
  it('appends a repository to the project', async () => {
    const proj = projectWithOneRepo();
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new AddRepositoryToProjectUseCase(repoStore);

    const result = await uc.execute({
      projectName: proj.name,
      repository: { path: path('/abs/second') },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repositories).toHaveLength(2);
    expect(result.value.repositories.map((r) => r.path)).toEqual(['/abs/first', '/abs/second']);
  });

  it('returns NotFoundError when project name unknown', async () => {
    const repoStore = new InMemoryProjectRepository();
    const uc = new AddRepositoryToProjectUseCase(repoStore);

    const result = await uc.execute({
      projectName: projectName('missing'),
      repository: { path: path('/abs/x') },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('returns ConflictError on duplicate repo path', async () => {
    const proj = projectWithOneRepo();
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new AddRepositoryToProjectUseCase(repoStore);

    const result = await uc.execute({
      projectName: proj.name,
      repository: { path: path('/abs/first') },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conflict');
  });

  it('returns ValidationError on bad repo input', async () => {
    const proj = projectWithOneRepo();
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new AddRepositoryToProjectUseCase(repoStore);

    const result = await uc.execute({
      projectName: proj.name,
      repository: { path: path('/abs/x'), checkScript: '   ' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});
