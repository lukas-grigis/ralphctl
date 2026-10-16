/**
 * Integration tests for the backup step. A full recursive copy of `data/` to a TIMESTAMPED sibling,
 * verified present before any rename. Each run's backup is distinct (never overwrites a prior one),
 * and existing backups are never re-copied into a new backup.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { backupDataDir, backupDirName } from '@src/integration/persistence/data-migration/backup.ts';

let appRoot: string;
let dataRoot: string;

beforeEach(async () => {
  appRoot = await fs.mkdtemp(join(tmpdir(), 'ralph-backup-'));
  dataRoot = join(appRoot, 'data');
  await fs.mkdir(join(dataRoot, 'projects'), { recursive: true });
  await fs.writeFile(join(dataRoot, 'projects', 'p.json'), '{"x":1}', 'utf8');
});

afterEach(async () => {
  await fs.rm(appRoot, { recursive: true, force: true });
});

const backupSiblings = async (): Promise<string[]> =>
  (await fs.readdir(appRoot)).filter((name) => name.startsWith('data.backup-'));

describe('backupDirName', () => {
  it('builds a timestamped, filesystem-safe name', () => {
    expect(backupDirName(1, '2026-06-19T10:00:00.000Z')).toBe('data.backup-v1-2026-06-19T10-00-00.000Z');
  });
});

describe('backupDataDir', () => {
  it('copies data/ into a timestamped sibling and returns its path', async () => {
    const res = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T10:00:00.000Z');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(join(appRoot, 'data.backup-v1-2026-06-19T10-00-00.000Z'));
    const copied = await fs.readFile(join(res.value, 'projects', 'p.json'), 'utf8');
    expect(copied).toBe('{"x":1}');
  });

  it('distinct timestamps → distinct backups (never overwrites a prior run)', async () => {
    const a = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T10:00:00.000Z');
    const b = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T11:00:00.000Z');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
    await expect(fs.stat(a.value)).resolves.toBeTruthy();
    await expect(fs.stat(b.value)).resolves.toBeTruthy();
  });

  it('fails when the copy is incomplete (fewer top-level entries than source) — caught BEFORE any rename', async () => {
    // Seed a second top-level family so the source has 2 entries; the partial copy will land only 1.
    await fs.mkdir(join(dataRoot, 'sprints'), { recursive: true });
    await fs.writeFile(join(dataRoot, 'sprints', 's.json'), '{}', 'utf8');

    // Model a disk-full / interrupted `fs.cp`: it creates the destination but only copies ONE of the
    // two top-level dirs, then resolves (no throw) — exactly the silent-partial case the verify guards.
    const spy = vi.spyOn(fs, 'cp').mockImplementation(async (_src, dest) => {
      await fs.mkdir(join(String(dest), 'projects'), { recursive: true });
    });
    try {
      const res = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T13:00:00.000Z');
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.message).toContain('incomplete');
      expect(await backupSiblings()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a copy that throws mid-way leaves no partial data.backup-* sibling behind', async () => {
    const spy = vi.spyOn(fs, 'cp').mockImplementation(async (_src, dest) => {
      await fs.mkdir(join(String(dest), 'projects'), { recursive: true });
      throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
    });
    try {
      const res = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T14:00:00.000Z');
      expect(res.ok).toBe(false);
      expect(await backupSiblings()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses to reuse an existing backup dir and leaves it untouched', async () => {
    const existing = join(appRoot, backupDirName(1, '2026-06-19T15:00:00.000Z'));
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(join(existing, 'earlier.json'), 'keep', 'utf8');

    const res = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T15:00:00.000Z');

    expect(res.ok).toBe(false);
    expect(await fs.readdir(existing)).toEqual(['earlier.json']);
  });

  it('leaves sprint worktrees out, so their node_modules links and symlink loops cannot fail or balloon it', async () => {
    const sprint = join(dataRoot, 'sprints', 'sprint-a');
    const worktree = join(sprint, 'worktrees', 'wt-task-a');
    const store = join(worktree, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules');
    await fs.mkdir(join(store, 'dep'), { recursive: true });
    await fs.writeFile(join(sprint, 'sprint.json'), '{"id":"a"}', 'utf8');
    await fs.writeFile(join(worktree, 'index.ts'), 'uncommitted', 'utf8');
    await fs.writeFile(join(store, 'dep', 'index.js'), 'module.exports = 1;', 'utf8');
    // pnpm layout: a top-level link into the store, and a workspace self-link that cycles back to the root.
    await fs.symlink('.pnpm/dep@1.0.0/node_modules/dep', join(worktree, 'node_modules', 'dep'));
    await fs.symlink('../../../..', join(store, 'app'));

    const res = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T16:00:00.000Z');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await fs.readFile(join(res.value, 'sprints', 'sprint-a', 'sprint.json'), 'utf8')).toBe('{"id":"a"}');
    expect(await fs.readdir(join(res.value, 'sprints', 'sprint-a'))).toEqual(['sprint.json']);
    // The live worktree is untouched.
    expect(await fs.readFile(join(worktree, 'index.ts'), 'utf8')).toBe('uncommitted');
  });

  it('copies any other symlink as a link instead of following it', async () => {
    const outside = join(appRoot, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, 'big.bin'), 'not ralphctl data', 'utf8');
    await fs.mkdir(join(dataRoot, 'memory'), { recursive: true });
    await fs.symlink('loop', join(dataRoot, 'memory', 'loop'));
    await fs.symlink('../../outside', join(dataRoot, 'projects', 'linked'));

    const res = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T17:00:00.000Z');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await fs.readlink(join(res.value, 'memory', 'loop'))).toBe('loop');
    // Verbatim target, so the copied link never points back into the live data/ tree.
    expect(await fs.readlink(join(res.value, 'projects', 'linked'))).toBe('../../outside');
  });

  it('copies a symlinked data/ by content, not as a link', async () => {
    const realData = join(appRoot, 'volume', 'data');
    await fs.mkdir(join(appRoot, 'volume'), { recursive: true });
    await fs.rename(dataRoot, realData);
    await fs.symlink(realData, dataRoot);

    const res = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T18:00:00.000Z');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((await fs.lstat(res.value)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(join(res.value, 'projects', 'p.json'), 'utf8')).toBe('{"x":1}');
  });

  it('does not copy existing data.backup-* siblings into the new backup', async () => {
    // A leftover backup sibling must NOT be nested into the new one.
    await fs.mkdir(join(appRoot, 'data.backup-v1-old'), { recursive: true });
    await fs.writeFile(join(appRoot, 'data.backup-v1-old', 'junk.txt'), 'x', 'utf8');

    const res = await backupDataDir(absolutePath(dataRoot), 1, '2026-06-19T12:00:00.000Z');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The new backup mirrors data/ only — no nested backup dir.
    const entries = await fs.readdir(res.value);
    expect(entries).not.toContain('data.backup-v1-old');
    expect(entries).toContain('projects');
  });
});
