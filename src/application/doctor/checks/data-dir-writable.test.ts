import { rm } from 'node:fs/promises';
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

  it('returns fail when the data dir does not exist', async () => {
    // Wipe the layout — write probe should fail because dataDir is gone.
    await rm(root, { recursive: true, force: true });
    const r = await dataDirWritableCheck({ storage });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('not writable');
  });
});
