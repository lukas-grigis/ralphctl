import { describe, expect, it } from 'vitest';

import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { InMemoryProjectRepository } from '@src/business/_test-fakes/in-memory-project-repository.ts';
import { CreateProjectUseCase } from './create-project.ts';

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

describe('CreateProjectUseCase', () => {
  it('persists a new project', async () => {
    const repoStore = new InMemoryProjectRepository();
    const uc = new CreateProjectUseCase(repoStore);

    const result = await uc.execute({
      name: projectName('demo'),
      displayName: 'Demo',
      repositories: [repo('/abs/repo')],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('demo');

    const list = await repoStore.list();
    if (!list.ok) throw new Error('list failed');
    expect(list.value).toHaveLength(1);
  });

  it('returns ValidationError when no repositories supplied', async () => {
    const repoStore = new InMemoryProjectRepository();
    const uc = new CreateProjectUseCase(repoStore);

    const result = await uc.execute({
      name: projectName('demo'),
      displayName: 'Demo',
      repositories: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('returns ConflictError when project name already exists', async () => {
    const seedR = Project.create({
      name: projectName('demo'),
      displayName: 'Demo',
      repositories: [repo('/abs/repo')],
    });
    if (!seedR.ok) throw new Error('precondition failed');
    const repoStore = new InMemoryProjectRepository([seedR.value]);
    const uc = new CreateProjectUseCase(repoStore);

    const result = await uc.execute({
      name: projectName('demo'),
      displayName: 'Demo 2',
      repositories: [repo('/abs/other')],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      if (result.error.code === 'conflict') {
        expect(result.error.entity).toBe('project');
      }
    }
  });
});
