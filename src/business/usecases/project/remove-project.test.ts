import { describe, expect, it } from 'vitest';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { InMemoryProjectRepository } from '../../_test-fakes/in-memory-project-repository.ts';
import { RemoveProjectUseCase } from './remove-project.ts';

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

function makeProject(name: string): Project {
  const repoR = Repository.create({ path: path(`/abs/${name}`) });
  if (!repoR.ok) throw new Error('precondition failed');
  const r = Project.create({
    name: projectName(name),
    displayName: name,
    repositories: [repoR.value],
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('RemoveProjectUseCase', () => {
  it('removes a project from the registry', async () => {
    const proj = makeProject('demo');
    const repoStore = new InMemoryProjectRepository([proj]);
    const uc = new RemoveProjectUseCase(repoStore);

    const result = await uc.execute({ name: proj.name });
    expect(result.ok).toBe(true);

    const list = await repoStore.list();
    if (!list.ok) throw new Error('list failed');
    expect(list.value).toEqual([]);
  });

  it('returns NotFoundError when name is unknown', async () => {
    const repoStore = new InMemoryProjectRepository();
    const uc = new RemoveProjectUseCase(repoStore);

    const result = await uc.execute({ name: projectName('missing') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
