import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryProjectRepository } from '../../../business/_test-fakes/in-memory-project-repository.ts';
import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { projectPathsExistCheck } from './project-paths-exist.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-paths-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

function buildProject(name: string, repoPath: AbsolutePath): Project {
  const pn = ProjectName.parse(name);
  if (!pn.ok) throw pn.error;
  const repo = Repository.create({ path: repoPath });
  if (!repo.ok) throw repo.error;
  const p = Project.create({
    name: pn.value,
    displayName: name,
    repositories: [repo.value],
  });
  if (!p.ok) throw p.error;
  return p.value;
}

describe('projectPathsExistCheck', () => {
  let root: AbsolutePath;

  beforeEach(() => {
    root = uniqueRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns skip when there are no registered projects', async () => {
    const r = await projectPathsExistCheck({
      projectRepo: new InMemoryProjectRepository(),
    });
    expect(r.status).toBe('skip');
    expect(r.message).toBe('no projects registered');
  });

  it('returns pass when every repo path is a git directory', async () => {
    const repoPath = AbsolutePath.trustString(join(root, 'repo'));
    await mkdir(join(repoPath, '.git'), { recursive: true });
    const p = buildProject('demo', repoPath);
    const r = await projectPathsExistCheck({
      projectRepo: new InMemoryProjectRepository([p]),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/1 repo verified/);
  });

  it('returns fail when a repo path is missing', async () => {
    const repoPath = AbsolutePath.trustString(join(root, 'ghost'));
    const p = buildProject('demo', repoPath);
    const r = await projectPathsExistCheck({
      projectRepo: new InMemoryProjectRepository([p]),
    });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('demo');
    expect(r.message).toContain('path missing');
  });

  it('returns fail when a path exists but is not a git repo', async () => {
    const repoPath = AbsolutePath.trustString(join(root, 'plain'));
    await mkdir(repoPath, { recursive: true });
    const p = buildProject('demo', repoPath);
    const r = await projectPathsExistCheck({
      projectRepo: new InMemoryProjectRepository([p]),
    });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('not a git repository');
  });
});
