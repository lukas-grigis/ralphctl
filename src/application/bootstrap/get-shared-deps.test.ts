import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { resolveStoragePaths, type StoragePaths } from '../runtime/storage-paths-resolver.ts';
import { getSharedDeps, resetSharedDeps, setSharedDeps } from './get-shared-deps.ts';
import { createSharedDeps } from './shared-deps.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-getdeps-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

describe('getSharedDeps', () => {
  let root: AbsolutePath;
  let storage: StoragePaths;

  beforeEach(() => {
    root = uniqueRoot();
    storage = resolveStoragePaths({ root });
    resetSharedDeps();
  });

  afterEach(async () => {
    resetSharedDeps();
    await rm(root, { recursive: true, force: true });
  });

  it('caches the graph after first build', async () => {
    const a = await getSharedDeps({ storage });
    const b = await getSharedDeps({ storage });
    expect(a).toBe(b);
  });

  it('setSharedDeps replaces the cached graph', async () => {
    const a = await getSharedDeps({ storage });
    const replacement = await createSharedDeps({ storage });
    setSharedDeps(replacement);
    const b = await getSharedDeps();
    expect(b).toBe(replacement);
    expect(b).not.toBe(a);
  });

  it('resetSharedDeps clears the cache so the next call rebuilds', async () => {
    const a = await getSharedDeps({ storage });
    resetSharedDeps();
    const b = await getSharedDeps({ storage });
    expect(b).not.toBe(a);
  });
});
