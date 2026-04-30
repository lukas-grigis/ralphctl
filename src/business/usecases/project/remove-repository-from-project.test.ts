import { describe, expect, it } from 'vitest';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { InMemoryProjectRepository } from '../../_test-fakes/in-memory-project-repository.ts';
import { RemoveRepositoryFromProjectUseCase } from './remove-repository-from-project.ts';

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

function repo(p: string): Repository {
  const r = Repository.create({ path: path(p) });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectWithRepos(...paths: readonly string[]): Project {
  const r = Project.create({
    name: projectName('demo'),
    displayName: 'Demo',
    repositories: paths.map(repo),
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('RemoveRepositoryFromProjectUseCase', () => {
  it('drops a repository from the project', async () => {
    const proj = projectWithRepos('/abs/a', '/abs/b');
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new RemoveRepositoryFromProjectUseCase(repoStore);

    const result = await uc.execute({ projectName: proj.name, path: path('/abs/a') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repositories.map((r) => r.path)).toEqual(['/abs/b']);
  });

  it('returns ValidationError when removing the last repository', async () => {
    const proj = projectWithRepos('/abs/only');
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new RemoveRepositoryFromProjectUseCase(repoStore);

    const result = await uc.execute({ projectName: proj.name, path: path('/abs/only') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('returns ValidationError when the repo path is not on the project', async () => {
    const proj = projectWithRepos('/abs/a', '/abs/b');
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new RemoveRepositoryFromProjectUseCase(repoStore);

    const result = await uc.execute({ projectName: proj.name, path: path('/abs/missing') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('returns NotFoundError when project name unknown', async () => {
    const repoStore = new InMemoryProjectRepository();
    const uc = new RemoveRepositoryFromProjectUseCase(repoStore);

    const result = await uc.execute({
      projectName: projectName('missing'),
      path: path('/abs/x'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
