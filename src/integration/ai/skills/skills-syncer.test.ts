import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { defaultBundledSkillsDir, FileSkillsSyncer } from './skills-syncer.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(
      tmpdir(),
      `ralphctl-skills-syncer-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    )
  );
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), body, 'utf-8');
}

describe('FileSkillsSyncer', () => {
  let cacheDir: AbsolutePath;
  let bundledDir: AbsolutePath;

  beforeEach(async () => {
    const root = uniqueRoot();
    cacheDir = AbsolutePath.trustString(join(root, 'cache'));
    bundledDir = AbsolutePath.trustString(join(root, 'bundled-default'));
    await mkdir(cacheDir, { recursive: true });
    await mkdir(bundledDir, { recursive: true });
  });

  afterEach(async () => {
    // The unique-root parent contains both cache + bundled trees — wipe
    // it via the path's grandparent.
    const grandparent = join(cacheDir, '..');
    await rm(grandparent, { recursive: true, force: true });
  });

  it('targets <cacheDir>/skills as the canonical sync directory', () => {
    const syncer = new FileSkillsSyncer({ cacheDir, bundledDefaultsDir: bundledDir });
    expect(syncer.cacheSkillsDir).toBe(join(cacheDir, 'skills'));
  });

  it('copies every bundled skill into cache/skills/ on first sync', async () => {
    await writeSkill(bundledDir, 'alpha', '---\nname: alpha\ndescription: a\n---\nbody-a');
    await writeSkill(bundledDir, 'beta', '---\nname: beta\ndescription: b\n---\nbody-b');

    const syncer = new FileSkillsSyncer({ cacheDir, bundledDefaultsDir: bundledDir });
    const r = await syncer.syncDefaults();
    expect(r.ok).toBe(true);

    const synced = await readdir(syncer.cacheSkillsDir);
    expect(synced.sort()).toEqual(['alpha', 'beta']);

    const alphaBody = await readFile(join(syncer.cacheSkillsDir, 'alpha', 'SKILL.md'), 'utf-8');
    expect(alphaBody).toContain('body-a');
  });

  it('is idempotent — a second sync is a no-op', async () => {
    await writeSkill(bundledDir, 'alpha', 'first version');
    const syncer = new FileSkillsSyncer({ cacheDir, bundledDefaultsDir: bundledDir });
    expect((await syncer.syncDefaults()).ok).toBe(true);

    // Mutate the cached copy. A second sync must not stomp the edit.
    await writeFile(join(syncer.cacheSkillsDir, 'alpha', 'SKILL.md'), 'edited locally', 'utf-8');
    expect((await syncer.syncDefaults()).ok).toBe(true);

    const cached = await readFile(join(syncer.cacheSkillsDir, 'alpha', 'SKILL.md'), 'utf-8');
    expect(cached).toBe('edited locally');
  });

  it('creates the cache/skills/ directory when missing', async () => {
    await writeSkill(bundledDir, 'gamma', 'body-g');
    const freshCache = AbsolutePath.trustString(join(cacheDir, 'subdir-that-does-not-exist'));
    const syncer = new FileSkillsSyncer({ cacheDir: freshCache, bundledDefaultsDir: bundledDir });
    const r = await syncer.syncDefaults();
    expect(r.ok).toBe(true);
    const entries = await readdir(syncer.cacheSkillsDir);
    expect(entries).toEqual(['gamma']);
  });

  it('skips loose files in the bundled default tree (only directories are skills)', async () => {
    await writeSkill(bundledDir, 'real', 'real-body');
    await writeFile(join(bundledDir, 'README.md'), 'not a skill', 'utf-8');
    const syncer = new FileSkillsSyncer({ cacheDir, bundledDefaultsDir: bundledDir });
    const r = await syncer.syncDefaults();
    expect(r.ok).toBe(true);
    const synced = await readdir(syncer.cacheSkillsDir);
    expect(synced).toEqual(['real']);
  });

  it('returns a StorageError when the bundled directory is missing', async () => {
    const missing = AbsolutePath.trustString(join(bundledDir, 'does-not-exist'));
    const syncer = new FileSkillsSyncer({ cacheDir, bundledDefaultsDir: missing });
    const r = await syncer.syncDefaults();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.subCode).toBe('io');
      expect(r.error.path).toBe(missing);
    }
  });

  it('exposes the resolved default bundled directory', () => {
    const dirPath = defaultBundledSkillsDir();
    expect(typeof dirPath).toBe('string');
    expect(dirPath.length).toBeGreaterThan(0);
  });

  it('copies nested directories within a skill', async () => {
    await mkdir(join(bundledDir, 'multi', 'nested'), { recursive: true });
    await writeFile(join(bundledDir, 'multi', 'SKILL.md'), 'top', 'utf-8');
    await writeFile(join(bundledDir, 'multi', 'nested', 'extra.md'), 'inner', 'utf-8');

    const syncer = new FileSkillsSyncer({ cacheDir, bundledDefaultsDir: bundledDir });
    expect((await syncer.syncDefaults()).ok).toBe(true);

    expect(await readFile(join(syncer.cacheSkillsDir, 'multi', 'SKILL.md'), 'utf-8')).toBe('top');
    expect(await readFile(join(syncer.cacheSkillsDir, 'multi', 'nested', 'extra.md'), 'utf-8')).toBe('inner');
  });

  it('syncs the real bundled defaults using the dev resolver', async () => {
    // Sanity: with no explicit bundledDefaultsDir override, the syncer
    // picks up the three real skills we copied into src.
    const syncer = new FileSkillsSyncer({ cacheDir });
    const r = await syncer.syncDefaults();
    expect(r.ok).toBe(true);
    const entries = await readdir(syncer.cacheSkillsDir);
    expect(entries.sort()).toEqual(['abstraction-first', 'alignment', 'iterative-review']);
  });
});
