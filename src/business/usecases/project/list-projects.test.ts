import { describe, expect, it } from 'vitest';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { InMemoryProjectRepository } from '../../_test-fakes/in-memory-project-repository.ts';
import { ListProjectsUseCase } from './list-projects.ts';

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

describe('ListProjectsUseCase', () => {
  it('returns an empty array when no projects exist', async () => {
    const repoStore = new InMemoryProjectRepository();
    const uc = new ListProjectsUseCase(repoStore);

    const result = await uc.execute();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns every persisted project', async () => {
    const repoStore = new InMemoryProjectRepository([makeProject('a'), makeProject('b')]);
    const uc = new ListProjectsUseCase(repoStore);

    const result = await uc.execute();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((p) => p.name).sort()).toEqual(['a', 'b']);
  });
});
