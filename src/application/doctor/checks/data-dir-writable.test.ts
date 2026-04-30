import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { ensureLayoutDirs, resolveStoragePaths, type StoragePaths } from '../../runtime/storage-paths-resolver.ts';
import { dataDirWritableCheck } from './data-dir-writable.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-doctor-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

describe('dataDirWritableCheck', () => {
  let root: AbsolutePath;
  let storage: StoragePaths;

  beforeEach(async () => {
    root = uniqueRoot();
    storage = resolveStoragePaths({ root });
    await ensureLayoutDirs(storage);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns pass for a writable data dir', async () => {
    const r = await dataDirWritableCheck({ storage });
    expect(r.name).toBe('Data directory');
    expect(r.status).toBe('pass');
    expect(r.message).toBe(storage.dataDir);
  });

  it('creates the data dir on the fly and passes when it was missing', async () => {
    // Layout dirs are created lazily by the composition root, so a fresh
    // install hits this check with no `dataDir` on disk. The check must
    // create-and-probe rather than fail.
    await rm(root, { recursive: true, force: true });
    const r = await dataDirWritableCheck({ storage });
    expect(r.status).toBe('pass');
    expect(r.message).toBe(storage.dataDir);
  });

  it('returns fail when the data dir cannot be created (parent is a file)', async () => {
    // Wipe the layout, then plant a regular file where `root` should be a
    // directory — `mkdir(dataDir, { recursive: true })` cannot resolve a
    // dir under it, so the probe fails.
    await rm(root, { recursive: true, force: true });
    await writeFile(root, 'not-a-dir');
    const r = await dataDirWritableCheck({ storage });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('not writable');
  });
});
