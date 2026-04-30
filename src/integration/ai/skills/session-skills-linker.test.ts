import { lstat, mkdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { FileSessionSkillsLinker, SKILLS_SUBDIR } from './session-skills-linker.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(
      tmpdir(),
      `ralphctl-skills-linker-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    )
  );
}

async function seedSkill(cacheSkillsDir: string, name: string): Promise<void> {
  const dir = join(cacheSkillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `# ${name}`, 'utf-8');
}

describe('FileSessionSkillsLinker', () => {
  let cacheSkillsDir: AbsolutePath;
  let sessionDir: AbsolutePath;

  beforeEach(async () => {
    const root = uniqueRoot();
    cacheSkillsDir = AbsolutePath.trustString(join(root, 'cache', 'skills'));
    sessionDir = AbsolutePath.trustString(join(root, 'session'));
    await mkdir(cacheSkillsDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    const grandparent = join(cacheSkillsDir, '..', '..');
    await rm(grandparent, { recursive: true, force: true });
  });

  it('creates symlinks under <sessionDir>/.claude/skills/<name>', async () => {
    await seedSkill(cacheSkillsDir, 'alpha');
    await seedSkill(cacheSkillsDir, 'beta');

    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    const r = await linker.link(sessionDir, ['alpha', 'beta']);
    expect(r.ok).toBe(true);

    const linkPath = join(sessionDir, SKILLS_SUBDIR, 'alpha');
    const stats = await lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);
    const target = await readlink(linkPath);
    expect(target).toBe(join(cacheSkillsDir, 'alpha'));
  });

  it('rebinds an existing symlink to the current source', async () => {
    await seedSkill(cacheSkillsDir, 'alpha');
    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    expect((await linker.link(sessionDir, ['alpha'])).ok).toBe(true);

    // Move the cache and re-link — the link should now point at the new
    // location. This exercises the "unlink existing then symlink" branch.
    const newCache = AbsolutePath.trustString(join(cacheSkillsDir, '..', 'skills-v2'));
    await mkdir(newCache, { recursive: true });
    await seedSkill(newCache, 'alpha');
    const linker2 = new FileSessionSkillsLinker({ cacheSkillsDir: newCache });
    expect((await linker2.link(sessionDir, ['alpha'])).ok).toBe(true);

    const linkPath = join(sessionDir, SKILLS_SUBDIR, 'alpha');
    const target = await readlink(linkPath);
    expect(target).toBe(join(newCache, 'alpha'));
  });

  it('leaves a non-symlink entry untouched and proceeds with the rest', async () => {
    await seedSkill(cacheSkillsDir, 'alpha');
    await seedSkill(cacheSkillsDir, 'beta');
    const skillsDir = join(sessionDir, SKILLS_SUBDIR);
    await mkdir(skillsDir, { recursive: true });
    // Plant a real file at the alpha link path. The linker must not
    // destroy it.
    await writeFile(join(skillsDir, 'alpha'), 'user owned', 'utf-8');

    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    const r = await linker.link(sessionDir, ['alpha', 'beta']);
    expect(r.ok).toBe(true);

    const alphaStats = await lstat(join(skillsDir, 'alpha'));
    expect(alphaStats.isFile()).toBe(true);
    const betaStats = await lstat(join(skillsDir, 'beta'));
    expect(betaStats.isSymbolicLink()).toBe(true);
  });

  it('unlink removes every symlink under skillsDir', async () => {
    await seedSkill(cacheSkillsDir, 'alpha');
    await seedSkill(cacheSkillsDir, 'beta');
    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    expect((await linker.link(sessionDir, ['alpha', 'beta'])).ok).toBe(true);

    const r = await linker.unlink(sessionDir);
    expect(r.ok).toBe(true);

    const alphaR = await lstat(join(sessionDir, SKILLS_SUBDIR, 'alpha')).catch(() => null);
    const betaR = await lstat(join(sessionDir, SKILLS_SUBDIR, 'beta')).catch(() => null);
    expect(alphaR).toBeNull();
    expect(betaR).toBeNull();
  });

  it('unlink leaves user-owned non-symlink entries intact', async () => {
    const skillsDir = join(sessionDir, SKILLS_SUBDIR);
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, 'user-file'), 'mine', 'utf-8');

    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    const r = await linker.unlink(sessionDir);
    expect(r.ok).toBe(true);

    const stats = await lstat(join(skillsDir, 'user-file'));
    expect(stats.isFile()).toBe(true);
  });

  it('unlink is a no-op when the skills dir does not exist', async () => {
    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    const r = await linker.unlink(sessionDir);
    expect(r.ok).toBe(true);
  });

  it('unlink is idempotent — second call after removal returns ok', async () => {
    await seedSkill(cacheSkillsDir, 'alpha');
    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    await linker.link(sessionDir, ['alpha']);
    expect((await linker.unlink(sessionDir)).ok).toBe(true);
    expect((await linker.unlink(sessionDir)).ok).toBe(true);
  });

  it('link creates the parent .claude/skills/ tree on demand', async () => {
    await seedSkill(cacheSkillsDir, 'alpha');
    const fresh = AbsolutePath.trustString(join(sessionDir, 'fresh'));
    await mkdir(fresh, { recursive: true });
    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    const r = await linker.link(fresh, ['alpha']);
    expect(r.ok).toBe(true);
    const stats = await lstat(join(fresh, SKILLS_SUBDIR, 'alpha'));
    expect(stats.isSymbolicLink()).toBe(true);
  });

  it('link with an empty skill list still succeeds (idempotent setup)', async () => {
    const linker = new FileSessionSkillsLinker({ cacheSkillsDir });
    const r = await linker.link(sessionDir, []);
    expect(r.ok).toBe(true);
  });
});
