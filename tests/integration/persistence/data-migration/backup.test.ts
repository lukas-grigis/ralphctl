/**
 * Integration tests for the backup step. A full recursive copy of `data/` to a TIMESTAMPED sibling,
 * verified present before any rename. Each run's backup is distinct (never overwrites a prior one),
 * and existing backups are never re-copied into a new backup.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
