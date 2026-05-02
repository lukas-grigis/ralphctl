import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeLoggerPort } from '@src/business/_test-fakes/fake-logger-port.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import { FileLocker } from './file-locker.ts';
import { FileSprintRepository } from './file-sprint-repository.ts';
import * as jsonIo from './json-io.ts';
import { ensureLayoutDirs, resolveStoragePaths, type StoragePaths } from './storage-paths.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-spr-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

function makeSprint(name: string, slugStr: string): Sprint {
  const slug = Slug.parse(slugStr);
  if (!slug.ok) throw slug.error;
  const pn = ProjectName.parse('demo-project');
  if (!pn.ok) throw pn.error;
  const r = Sprint.create({
    name,
    slug: slug.value,
    now: IsoTimestamp.trustString('2026-04-29T00:00:00.000Z'),
    projectName: pn.value,
  });
  if (!r.ok) throw r.error;
  return r.value;
}

describe('FileSprintRepository', () => {
  let root: AbsolutePath;
  let paths: StoragePaths;
  let repo: FileSprintRepository;

  beforeEach(async () => {
    root = uniqueRoot();
    paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    repo = new FileSprintRepository(paths, new FileLocker());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('save and findById round-trip a draft sprint', async () => {
    const s = makeSprint('Demo', 'demo');
    const w = await repo.save(s);
    expect(w.ok).toBe(true);
    const r = await repo.findById(s.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe(s.id);
      expect(r.value.name).toBe('Demo');
    }
  });

  it('findById returns NotFoundError when the sprint does not exist', async () => {
    const ghost = 'ghost-id-that-does-not-exist' as unknown as SprintId;
    const r = await repo.findById(ghost);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });

  it('list returns an empty array on a fresh root', async () => {
    const r = await repo.list();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toStrictEqual([]);
  });

  it('list returns all persisted sprints', async () => {
    const a = makeSprint('Alpha', 'alpha');
    const b = makeSprint('Beta', 'beta');
    await repo.save(a);
    await repo.save(b);
    const r = await repo.list();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.map((s) => s.id).sort();
    expect(ids).toStrictEqual([a.id, b.id].sort());
  });

  it('list silently skips an unparseable sprint dir (corrupt file)', async () => {
    const a = makeSprint('Good', 'good');
    await repo.save(a);
    // Plant a corrupt sprint dir alongside the valid one.
    const badId = '20260429-141522-broken';
    await mkdir(join(paths.sprintsDir, badId), { recursive: true });
    await writeFile(join(paths.sprintsDir, badId, 'sprint.json'), '{not-json');
    const r = await repo.list();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((s) => s.id)).toStrictEqual([a.id]);
  });

  it('list emits a warn through the logger when skipping a corrupt sprint dir', async () => {
    const logger = new FakeLoggerPort();
    const repoWithLogger = new FileSprintRepository(paths, new FileLocker(), logger);

    const good = makeSprint('Good', 'good');
    await repoWithLogger.save(good);

    const badId = '20260429-090909-broken';
    await mkdir(join(paths.sprintsDir, badId), { recursive: true });
    await writeFile(join(paths.sprintsDir, badId, 'sprint.json'), '{not-json');

    const r = await repoWithLogger.list();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((s) => s.id)).toStrictEqual([good.id]);

    expect(logger.hasMessage('warn', 'corrupt sprint dir')).toBe(true);
    const warn = logger.entries.find((e) => e.level === 'warn');
    expect(warn?.context['path']).toContain(badId);
    expect(warn?.context['cause']).toBeDefined();
  });

  it('list returns empty when the sprints directory is missing entirely', async () => {
    await rm(paths.sprintsDir, { recursive: true, force: true });
    const r = await repo.list();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toStrictEqual([]);
  });

  it('remove deletes the sprint directory', async () => {
    const s = makeSprint('Removable', 'removable');
    await repo.save(s);
    const r = await repo.remove(s.id);
    expect(r.ok).toBe(true);
    const after = await repo.findById(s.id);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('not-found');
  });

  it('remove returns NotFoundError when the sprint does not exist', async () => {
    const ghost = 'never-existed' as unknown as SprintId;
    const r = await repo.remove(ghost);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });

  it('save persists tickets nested in the sprint', async () => {
    const draft = makeSprint('With ticket', 'wt');
    const ticket = Ticket.create({ title: 'My ticket' });
    if (!ticket.ok) throw ticket.error;
    const withTicket = draft.addTicket(ticket.value);
    if (!withTicket.ok) throw withTicket.error;
    await repo.save(withTicket.value);
    const r = await repo.findById(withTicket.value.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tickets).toHaveLength(1);
  });

  it('serialises concurrent saves of the same sprint', async () => {
    const s = makeSprint('Race', 'race');
    // Save two snapshots in parallel; the file lock must serialise them.
    const [r1, r2] = await Promise.all([repo.save(s), repo.save(s)]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const after = await repo.findById(s.id);
    expect(after.ok).toBe(true);
  });

  it('list reads sprint files concurrently (Promise.all, not sequential)', async () => {
    // Persist three sprints, then stub readJsonFile so each call records its
    // start time and resolves only after a delay. If the loop were
    // sequential, the second call would not begin until the first resolved
    // (start[1] >= start[0] + delay). With Promise.all, all calls begin
    // overlapping (start[i] - start[0] is well under `delay`).
    const sprints = await Promise.all([
      repo.save(makeSprint('A', 'aaa')),
      repo.save(makeSprint('B', 'bbb')),
      repo.save(makeSprint('C', 'ccc')),
    ]);
    expect(sprints.every((r) => r.ok)).toBe(true);

    const realReadJsonFile = jsonIo.readJsonFile;
    const starts: number[] = [];
    const delayMs = 60;
    const spy = vi.spyOn(jsonIo, 'readJsonFile').mockImplementation(async (path, schema) => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return realReadJsonFile(path, schema);
    });

    try {
      const r = await repo.list();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toHaveLength(3);
      // We saw at least 3 reads, all kicked off before the first resolved.
      expect(starts.length).toBeGreaterThanOrEqual(3);
      const first = starts[0] ?? 0;
      // Every other call started before the first finished — overlap proves
      // concurrency. Generous slack to absorb scheduler jitter; sequential
      // execution would push later starts past `first + delayMs`.
      for (let i = 1; i < starts.length; i += 1) {
        expect((starts[i] ?? 0) - first).toBeLessThan(delayMs);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
