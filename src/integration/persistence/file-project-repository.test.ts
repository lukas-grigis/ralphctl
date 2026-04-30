import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Project } from '../../domain/entities/project.ts';
import { Repository } from '../../domain/entities/repository.ts';
import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { ProjectName } from '../../domain/values/project-name.ts';
import { FileLocker } from './file-locker.ts';
import { FileProjectRepository } from './file-project-repository.ts';
import { ensureLayoutDirs, resolveStoragePaths, type StoragePaths } from './storage-paths.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-prj-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

function makeProject(name: string, repoPath: string): Project {
  const pn = ProjectName.parse(name);
  if (!pn.ok) throw pn.error;
  const repo = Repository.create({ path: AbsolutePath.trustString(repoPath) });
  if (!repo.ok) throw repo.error;
  const p = Project.create({
    name: pn.value,
    displayName: name,
    repositories: [repo.value],
  });
  if (!p.ok) throw p.error;
  return p.value;
}

describe('FileProjectRepository', () => {
  let root: AbsolutePath;
  let paths: StoragePaths;
  let repo: FileProjectRepository;

  beforeEach(async () => {
    root = uniqueRoot();
    paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    repo = new FileProjectRepository(paths, new FileLocker());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('list returns an empty array when projects.json does not exist', async () => {
    const r = await repo.list();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('findByName returns NotFoundError when projects.json does not exist', async () => {
    const pn = ProjectName.parse('ghost');
    if (!pn.ok) throw pn.error;
    const r = await repo.findByName(pn.value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });

  it('save then findByName round-trips a project', async () => {
    const p = makeProject('demo', '/code/demo');
    const w = await repo.save(p);
    expect(w.ok).toBe(true);
    const r = await repo.findByName(p.name);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.displayName).toBe('demo');
  });

  it('save upserts by name (no duplicates)', async () => {
    const p1 = makeProject('demo', '/code/demo');
    await repo.save(p1);
    // Save again with a new repository — entity-level path uniqueness lives
    // inside the aggregate; here we exercise the upsert (one entry per name).
    const p2 = makeProject('demo', '/code/demo-v2');
    await repo.save(p2);
    const list = await repo.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    expect(list.value[0]?.repositories[0]?.path).toBe('/code/demo-v2');
  });

  it('list returns multiple projects', async () => {
    await repo.save(makeProject('a', '/code/a'));
    await repo.save(makeProject('b', '/code/b'));
    const r = await repo.list();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((p) => p.name).sort()).toEqual(['a', 'b']);
  });

  it('remove deletes the project', async () => {
    const p = makeProject('rm-me', '/code/x');
    await repo.save(p);
    const r = await repo.remove(p.name);
    expect(r.ok).toBe(true);
    const after = await repo.findByName(p.name);
    expect(after.ok).toBe(false);
  });

  it('remove returns NotFoundError when the project does not exist', async () => {
    const pn = ProjectName.parse('absent');
    if (!pn.ok) throw pn.error;
    const r = await repo.remove(pn.value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });

  it('serialises concurrent saves on the single envelope file', async () => {
    const p1 = makeProject('a', '/code/a');
    const p2 = makeProject('b', '/code/b');
    const [r1, r2] = await Promise.all([repo.save(p1), repo.save(p2)]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const list = await repo.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      // Both saves must land — the envelope ends up with both entries.
      expect(list.value.map((p) => p.name).sort()).toEqual(['a', 'b']);
    }
  });
});
