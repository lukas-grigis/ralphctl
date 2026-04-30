import { stat } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { ensureLayoutDirs, resolveStoragePaths } from './storage-paths-resolver.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-spr-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

describe('storage-paths-resolver', () => {
  let root: AbsolutePath;

  beforeEach(() => {
    root = uniqueRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ensureLayoutDirs creates configDir, sprintsDir, cacheDir, logsDir, backupsDir', async () => {
    const paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);

    expect(await isDir(paths.configDir)).toBe(true);
    expect(await isDir(paths.sprintsDir)).toBe(true);
    expect(await isDir(paths.cacheDir)).toBe(true);
    expect(await isDir(paths.logsDir)).toBe(true);
    expect(await isDir(paths.backupsDir)).toBe(true);
  });

  it('ensureLayoutDirs is idempotent', async () => {
    const paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    // Second call must not throw.
    await ensureLayoutDirs(paths);
    expect(await isDir(paths.configDir)).toBe(true);
  });

  it('resolveStoragePaths exposes configFile + projectsFile under configDir', () => {
    const paths = resolveStoragePaths({ root });
    expect(paths.configFile.startsWith(paths.configDir)).toBe(true);
    expect(paths.projectsFile.startsWith(paths.configDir)).toBe(true);
  });
});
