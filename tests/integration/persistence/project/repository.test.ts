import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { join } from 'node:path';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { projectFile, projectsDir } from '@src/integration/persistence/storage.ts';
import { toJsonProject } from '@src/integration/persistence/project/project.schema.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { ProjectId as ProjectIdType } from '@src/domain/value/id/project-id.ts';

/** Legacy bare-`<id>.json` project file path — pre-slug installs wrote this; the resolver tolerates it. */
const legacyProjectFile = (root: AbsolutePath, id: ProjectIdType): string =>
  join(projectsDir(root), `${String(id)}.json`);

describe('createFsProjectRepository', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
  });

  afterEach(async () => cleanup());

  it('round-trips a project through save → findById', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject();

    const saved = await repo.save(project);
    expect(saved.ok).toBe(true);

    const loaded = await repo.findById(project.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(project);
  });

  it('returns NotFoundError for an unknown id', async () => {
    const repo = createFsProjectRepository({ root });

    const loaded = await repo.findById(ProjectId.generate());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toBeInstanceOf(NotFoundError);
  });

  it('looks up by globally-unique slug', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject();
    await repo.save(project);

    const loaded = await repo.findBySlug(project.slug);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.id).toBe(project.id);
  });

  it('returns NotFoundError for an unknown slug', async () => {
    const repo = createFsProjectRepository({ root });
    await repo.save(makeProject());

    const other = makeProject({ id: ProjectId.generate(), slug: 'someone-else' });
    const loaded = await repo.findBySlug(other.slug);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toBeInstanceOf(NotFoundError);
  });

  it('list returns an empty array when no projects exist', async () => {
    const repo = createFsProjectRepository({ root });
    const all = await repo.list();
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value).toEqual([]);
    }
  });

  it('list returns every project in canonical (id-asc) order', async () => {
    const repo = createFsProjectRepository({ root });
    const a = makeProject({ id: ProjectId.generate(), slug: 'a' });
    const b = makeProject({ id: ProjectId.generate(), slug: 'b' });
    const c = makeProject({ id: ProjectId.generate(), slug: 'c' });
    await repo.save(c);
    await repo.save(a);
    await repo.save(b);

    const all = await repo.list();
    expect(all.ok).toBe(true);
    if (all.ok) {
      const expectedOrder = [a.id, b.id, c.id].sort();
      expect(all.value.map((p) => p.id)).toEqual(expectedOrder);
    }
  });

  it('list dedupes by id when a legacy <id>.json and slugged <id>--<slug>.json transiently coexist', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject();
    // Hand-write BOTH a slugged (canonical) file and a legacy bare file for the SAME id — a crash-left
    // pair (save wrote the new file but the stale-sibling cleanup did not finish).
    await fs.mkdir(projectsDir(root), { recursive: true });
    await fs.writeFile(projectFile(root, project.id, project.slug), JSON.stringify(toJsonProject(project)), 'utf8');
    await fs.writeFile(legacyProjectFile(root, project.id), JSON.stringify(toJsonProject(project)), 'utf8');

    const all = await repo.list();
    if (!all.ok) throw new Error('list failed');
    // The project appears EXACTLY once, not twice.
    expect(all.value.filter((p) => p.id === project.id)).toHaveLength(1);
  });

  it('save overwrites an existing project (upsert)', async () => {
    const repo = createFsProjectRepository({ root });
    const original = makeProject({ displayName: 'old name' });
    await repo.save(original);
    const updated = { ...original, displayName: 'new name' };
    await repo.save(updated);

    const loaded = await repo.findById(original.id);
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.displayName).toBe('new name');
  });

  it('remove deletes the project; subsequent findById returns NotFoundError', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject();
    await repo.save(project);

    const removed = await repo.remove(project.id);
    expect(removed.ok).toBe(true);
    const loaded = await repo.findById(project.id);
    expect(loaded.ok).toBe(false);
  });

  it('remove of an unknown id returns NotFoundError', async () => {
    const repo = createFsProjectRepository({ root });
    const removed = await repo.remove(ProjectId.generate());
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error).toBeInstanceOf(NotFoundError);
  });

  it('round-trips a repository carrying suggestedSkills through save → findById', async () => {
    const repo = createFsProjectRepository({ root });
    const repository = { ...makeRepository({ name: 'svc' }), suggestedSkills: ['react-patterns', 'pnpm'] as const };
    const project = makeProject({ repositories: [repository] });

    await repo.save(project);
    const loaded = await repo.findById(project.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.repositories[0]?.suggestedSkills).toEqual(['react-patterns', 'pnpm']);
  });

  it('round-trips a repository carrying structured verifyGates through save → findById', async () => {
    const repo = createFsProjectRepository({ root });
    const gates = [
      { pathPrefix: 'apps/web-ui', command: 'pnpm --filter web-ui test', timeoutMs: 60_000 },
      { pathPrefix: '', command: 'pnpm lint' },
    ] as const;
    const repository = { ...makeRepository({ name: 'svc' }), verifyGates: gates };
    const project = makeProject({ repositories: [repository] });

    await repo.save(project);
    const loaded = await repo.findById(project.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.repositories[0]?.verifyGates).toEqual(gates);
  });

  it('tolerates a persisted project.json whose repository omits verifyGates (legacy file)', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject({ repositories: [makeRepository({ name: 'svc' })] });
    await fs.mkdir(projectsDir(root), { recursive: true });
    const onDisk = JSON.parse(JSON.stringify(project)) as Record<string, unknown>;
    expect((onDisk.repositories as Array<Record<string, unknown>>)[0]).not.toHaveProperty('verifyGates');
    await fs.writeFile(legacyProjectFile(root, project.id), JSON.stringify(onDisk), 'utf8');

    const loaded = await repo.findById(project.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.repositories[0]?.verifyGates).toBeUndefined();
  });

  it('tolerates a persisted project.json whose repository omits suggestedSkills (legacy file)', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject({ repositories: [makeRepository({ name: 'svc' })] });
    // Write a project file by hand with NO `suggestedSkills` key on the repository — the shape
    // a project.json persisted before the field existed has on disk.
    await fs.mkdir(projectsDir(root), { recursive: true });
    const onDisk = JSON.parse(JSON.stringify(project)) as Record<string, unknown>;
    expect((onDisk.repositories as Array<Record<string, unknown>>)[0]).not.toHaveProperty('suggestedSkills');
    await fs.writeFile(legacyProjectFile(root, project.id), JSON.stringify(onDisk), 'utf8');

    const loaded = await repo.findById(project.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.repositories[0]?.suggestedSkills).toBeUndefined();
  });

  it('save writes the new <id>--<slug>.json name on disk', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject({ slug: 'cool-project' });
    await repo.save(project);

    const slugged = projectFile(root, project.id, project.slug);
    expect((await fs.stat(slugged)).isFile()).toBe(true);
  });

  it('findById resolves a legacy bare <id>.json written by a pre-slug install', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject();
    await fs.mkdir(projectsDir(root), { recursive: true });
    await fs.writeFile(legacyProjectFile(root, project.id), JSON.stringify(toJsonProject(project)), 'utf8');

    const loaded = await repo.findById(project.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.id).toBe(project.id);
  });

  it('reconcile-on-save: removes a legacy bare <id>.json after writing the slugged name', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject({ slug: 'cool-project' });
    await fs.mkdir(projectsDir(root), { recursive: true });
    await fs.writeFile(legacyProjectFile(root, project.id), JSON.stringify(toJsonProject(project)), 'utf8');

    await repo.save(project);

    const slugged = projectFile(root, project.id, project.slug);
    expect((await fs.stat(slugged)).isFile()).toBe(true);
    await expect(fs.stat(legacyProjectFile(root, project.id))).rejects.toThrow();
  });

  it('reconcile-on-save: removes a stale <id>--<oldSlug>.json after a slug rename', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject({ slug: 'old-slug' });
    await repo.save(project);
    const oldFile = projectFile(root, project.id, project.slug);
    expect((await fs.stat(oldFile)).isFile()).toBe(true);

    const other = makeProject({ id: project.id, slug: 'new-slug', repositories: project.repositories as never });
    await repo.save(other);

    const newFile = projectFile(root, other.id, other.slug);
    expect((await fs.stat(newFile)).isFile()).toBe(true);
    await expect(fs.stat(oldFile)).rejects.toThrow();
  });

  it('surfaces invalid JSON on disk as StorageError(parse)', async () => {
    const repo = createFsProjectRepository({ root });
    const project = makeProject();
    const path = legacyProjectFile(root, project.id);
    await fs.mkdir(projectsDir(root), { recursive: true });
    await fs.writeFile(path, 'not json {{');

    const loaded = await repo.findById(project.id);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toBeInstanceOf(StorageError);
      expect((loaded.error as StorageError).subCode).toBe('parse');
    }
  });
});
