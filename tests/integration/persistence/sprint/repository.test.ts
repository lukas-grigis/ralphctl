import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeDraftSprintBundle } from '@tests/fixtures/domain.ts';
import { Slug } from '@src/domain/value/slug.ts';
import { join } from 'node:path';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { toJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';
import { buildSluggedName, sprintDir, sprintFile, sprintsDir } from '@src/integration/persistence/storage.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

/** Serialise a sprint to its on-disk JSON shape (for hand-writing legacy-named fixtures). */
const toJsonForTest = toJsonSprint;

const slugUnchecked = (s: string) => {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error(`bad slug: ${s}`);
  return r.value;
};

describe('createFsSprintRepository', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
  });

  afterEach(async () => cleanup());

  it('round-trips a sprint through save → findById', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle();

    const saved = await repo.save(sprint);
    expect(saved.ok).toBe(true);

    const loaded = await repo.findById(sprint.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual(sprint);
  });

  it('returns NotFoundError for an unknown id', async () => {
    const repo = createFsSprintRepository({ root });
    const loaded = await repo.findById(SprintId.generate());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toBeInstanceOf(NotFoundError);
  });

  it('looks up by (projectId, slug) — slugs are unique only within their project', async () => {
    const repo = createFsSprintRepository({ root });
    const projectA = ProjectId.generate();
    const projectB = ProjectId.generate();
    const slug = slugUnchecked('cool-sprint');

    const sprintInA = makeDraftSprintBundle({ projectId: projectA, slug: 'cool-sprint' }).sprint;
    const sprintInB = makeDraftSprintBundle({ projectId: projectB, slug: 'cool-sprint' }).sprint;
    await repo.save(sprintInA);
    await repo.save(sprintInB);

    const fromA = await repo.findBySlug(slug, projectA);
    const fromB = await repo.findBySlug(slug, projectB);
    if (!fromA.ok || !fromB.ok) throw new Error('findBySlug failed');
    expect(fromA.value.id).toBe(sprintInA.id);
    expect(fromB.value.id).toBe(sprintInB.id);
  });

  it('findBySlug returns NotFoundError when slug is unknown in scope', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle();
    await repo.save(sprint);

    const result = await repo.findBySlug(slugUnchecked('does-not-exist'), sprint.projectId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundError);
  });

  it('list skips stray files in <root>/sprints (e.g. macOS .DS_Store) instead of failing', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle();
    await repo.save(sprint);
    // Drop a stray FILE next to the per-sprint subdirs. listDir returns its name, the loop
    // tries to read <root>/sprints/.DS_Store/sprint.json and hits ENOTDIR — must be skipped,
    // not surfaced as an error.
    await fs.writeFile(`${String(root)}/sprints/.DS_Store`, 'Mac Finder metadata\n');

    const all = await repo.list();
    if (!all.ok) throw new Error(`expected ok, got: ${all.error.message}`);
    expect(all.value.map((s) => s.id)).toEqual([sprint.id]);
  });

  it('list returns chronological order via UUIDv7 lex sort', async () => {
    const repo = createFsSprintRepository({ root });
    const a = makeDraftSprintBundle({ slug: 'a' }).sprint;
    await new Promise((r) => setTimeout(r, 5)); // ensure UUIDv7 timestamps differ
    const b = makeDraftSprintBundle({ slug: 'b' }).sprint;
    await new Promise((r) => setTimeout(r, 5));
    const c = makeDraftSprintBundle({ slug: 'c' }).sprint;
    await repo.save(c);
    await repo.save(a);
    await repo.save(b);

    const all = await repo.list();
    if (!all.ok) throw new Error('list failed');
    expect(all.value.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it('save overwrites an existing sprint (upsert)', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle({ name: 'old' });
    await repo.save(sprint);
    const updated = { ...sprint, name: 'new' };
    await repo.save(updated);

    const loaded = await repo.findById(sprint.id);
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.name).toBe('new');
  });

  it('remove deletes the whole sprint directory; findById then NotFound', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle();
    await repo.save(sprint);

    const removed = await repo.remove(sprint.id);
    expect(removed.ok).toBe(true);
    const loaded = await repo.findById(sprint.id);
    expect(loaded.ok).toBe(false);
  });

  it('remove of an unknown id returns NotFoundError', async () => {
    const repo = createFsSprintRepository({ root });
    const removed = await repo.remove(SprintId.generate());
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error).toBeInstanceOf(NotFoundError);
  });

  it('save writes the new <id>--<slug>/ dir name on disk', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle({ slug: 'cool-sprint' });
    await repo.save(sprint);

    const slugged = sprintDir(root, sprint.id, sprint.slug);
    const stat = await fs.stat(join(slugged, 'sprint.json'));
    expect(stat.isFile()).toBe(true);
  });

  it('findById resolves a legacy bare <id>/ dir written by a pre-slug install', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle();
    // Hand-write the sprint under the LEGACY bare-id dir name.
    const legacyDir = join(sprintsDir(root), String(sprint.id));
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(join(legacyDir, 'sprint.json'), JSON.stringify(toJsonForTest(sprint)), 'utf8');

    const loaded = await repo.findById(sprint.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.id).toBe(sprint.id);
  });

  it('reconcile-on-save: renames a legacy <id>/ dir to <id>--<slug>/ (sub-files move with it)', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle({ slug: 'cool-sprint' });
    const legacyDir = join(sprintsDir(root), String(sprint.id));
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(join(legacyDir, 'sprint.json'), JSON.stringify(toJsonForTest(sprint)), 'utf8');
    // A sibling sub-file the rename must carry across atomically.
    await fs.writeFile(join(legacyDir, 'execution.json'), '{"marker":true}', 'utf8');

    await repo.save(sprint);

    const slugged = sprintDir(root, sprint.id, sprint.slug);
    // New dir holds BOTH the sprint and the carried-over execution; old bare dir is gone.
    expect((await fs.stat(join(slugged, 'sprint.json'))).isFile()).toBe(true);
    expect((await fs.stat(join(slugged, 'execution.json'))).isFile()).toBe(true);
    await expect(fs.stat(legacyDir)).rejects.toThrow();
  });

  it('reconcile-on-save: removes a stale <id>--<oldSlug>/ dir after a slug rename', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle({ slug: 'old-slug' });
    await repo.save(sprint);
    const oldDir = sprintDir(root, sprint.id, sprint.slug);
    expect((await fs.stat(oldDir)).isDirectory()).toBe(true);

    const renamed = { ...sprint, slug: slugUnchecked('new-slug') };
    await repo.save(renamed);

    const newDir = join(sprintsDir(root), buildSluggedName(String(sprint.id), 'new-slug'));
    expect((await fs.stat(join(newDir, 'sprint.json'))).isFile()).toBe(true);
    await expect(fs.stat(oldDir)).rejects.toThrow();
  });

  it('list parses the id from the leading --segment of a mixed (legacy + slugged) dir set', async () => {
    const repo = createFsSprintRepository({ root });
    const a = makeDraftSprintBundle({ slug: 'a' }).sprint;
    await new Promise((r) => setTimeout(r, 5));
    const b = makeDraftSprintBundle({ slug: 'b' }).sprint;
    // a → new slugged dir (via save); b → legacy bare dir (hand-written).
    await repo.save(a);
    const legacyDir = join(sprintsDir(root), String(b.id));
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(join(legacyDir, 'sprint.json'), JSON.stringify(toJsonForTest(b)), 'utf8');

    const all = await repo.list();
    if (!all.ok) throw new Error('list failed');
    expect(all.value.map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('surfaces invalid JSON on disk as StorageError(parse)', async () => {
    const repo = createFsSprintRepository({ root });
    const { sprint } = makeDraftSprintBundle();
    const path = sprintFile(root, sprint.id, sprint.slug);
    await fs.mkdir(path.replace(/sprint\.json$/, ''), { recursive: true });
    await fs.writeFile(path, '{ "broken": ');

    const loaded = await repo.findById(sprint.id);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toBeInstanceOf(StorageError);
      expect((loaded.error as StorageError).subCode).toBe('parse');
    }
  });
});
