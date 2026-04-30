import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { SprintId } from '../../domain/values/sprint-id.ts';
import { FileLocker } from '../../integration/persistence/file-locker.ts';
import {
  ensureLayoutDirs,
  resolveStoragePaths,
  type StoragePaths,
} from '../../integration/persistence/storage-paths.ts';
import { CONFIG_DEFAULTS } from './config-defaults.ts';
import type { Config } from './config.ts';
import { FileConfigStore } from './file-config-store.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-cfg-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

describe('FileConfigStore', () => {
  let root: AbsolutePath;
  let paths: StoragePaths;
  let store: FileConfigStore;

  beforeEach(async () => {
    root = uniqueRoot();
    paths = resolveStoragePaths({ root });
    await ensureLayoutDirs(paths);
    store = new FileConfigStore(paths, new FileLocker());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('load returns CONFIG_DEFAULTS when config.json does not exist', async () => {
    const r = await store.load();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(CONFIG_DEFAULTS);
  });

  it('save then load round-trips every field', async () => {
    const sprintIdR = SprintId.parse('20260429-141522-demo');
    if (!sprintIdR.ok) throw sprintIdR.error;
    const cfg: Config = {
      currentSprint: sprintIdR.value,
      aiProvider: 'claude',
      editor: 'vim',
      evaluationIterations: 3,
      logLevel: 'debug',
    };
    const w = await store.save(cfg);
    expect(w.ok).toBe(true);
    const r = await store.load();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(cfg);
  });

  it('save then load preserves nulls', async () => {
    const cfg: Config = {
      currentSprint: null,
      aiProvider: null,
      editor: null,
      evaluationIterations: 0,
      logLevel: 'warn',
    };
    const w = await store.save(cfg);
    expect(w.ok).toBe(true);
    const r = await store.load();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(cfg);
  });

  it('load fills missing fields with defaults', async () => {
    // Manually write a partial file — only `aiProvider` set.
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.configFile, JSON.stringify({ aiProvider: 'copilot' }));

    const r = await store.load();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.aiProvider).toBe('copilot');
      expect(r.value.currentSprint).toBeNull();
      expect(r.value.editor).toBeNull();
      expect(r.value.evaluationIterations).toBe(CONFIG_DEFAULTS.evaluationIterations);
      expect(r.value.logLevel).toBe(CONFIG_DEFAULTS.logLevel);
    }
  });

  it('load surfaces a StorageError when the file is malformed JSON', async () => {
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.configFile, '{not json');
    const r = await store.load();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.subCode).toBe('parse');
    }
  });

  it('load surfaces a StorageError on schema mismatch', async () => {
    await mkdir(paths.configDir, { recursive: true });
    // `evaluationIterations` is supposed to be a number — string fails.
    await writeFile(paths.configFile, JSON.stringify({ evaluationIterations: 'lots' }));
    const r = await store.load();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.subCode).toBe('schema-mismatch');
    }
  });

  it('load rejects an invalid currentSprint as schema-mismatch', async () => {
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.configFile, JSON.stringify({ currentSprint: 'not-a-sprint-id' }));
    const r = await store.load();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.subCode).toBe('schema-mismatch');
    }
  });

  it('save then save again overwrites the prior value', async () => {
    const first: Config = { ...CONFIG_DEFAULTS, evaluationIterations: 2 };
    const second: Config = { ...CONFIG_DEFAULTS, evaluationIterations: 5 };
    const w1 = await store.save(first);
    expect(w1.ok).toBe(true);
    const w2 = await store.save(second);
    expect(w2.ok).toBe(true);
    const r = await store.load();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.evaluationIterations).toBe(5);
  });
});
