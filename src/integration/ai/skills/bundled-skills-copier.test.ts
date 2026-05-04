import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { FileBundledSkillsCopier, SKILLS_SUBDIR } from './bundled-skills-copier.ts';

function uniqueRoot(): string {
  return join(
    tmpdir(),
    `ralphctl-bundled-skills-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  );
}

/**
 * Materialise a fake bundled-skills root with the four phase folders.
 * Each entry in `layout` is `{ phase: 'default' | <phase>, name, body? }`.
 * Empty phases default to no skills.
 */
async function materialiseBundledRoot(
  bundledRoot: string,
  layout: readonly { readonly phase: string; readonly name: string; readonly body?: string }[]
): Promise<void> {
  for (const phase of ['default', 'refine', 'plan', 'exec']) {
    await mkdir(join(bundledRoot, phase), { recursive: true });
  }
  for (const item of layout) {
    const dir = join(bundledRoot, item.phase, item.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), item.body ?? `${item.phase}/${item.name}`, 'utf-8');
  }
}

describe('FileBundledSkillsCopier', () => {
  let root: string;
  let bundledDir: AbsolutePath;
  let sessionDir: AbsolutePath;

  beforeEach(async () => {
    root = uniqueRoot();
    bundledDir = AbsolutePath.trustString(join(root, 'bundled'));
    sessionDir = AbsolutePath.trustString(join(root, 'session'));
    await mkdir(bundledDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('install copies the union of default/ and <phase>/ skills', async () => {
    await materialiseBundledRoot(bundledDir, [
      { phase: 'default', name: 'alpha' },
      { phase: 'refine', name: 'gamma' },
      { phase: 'plan', name: 'should-not-show' },
    ]);

    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r = await copier.install(sessionDir, 'refine');
    expect(r.ok).toBe(true);

    const skillsDir = join(sessionDir, SKILLS_SUBDIR);
    const entries = await readdir(skillsDir);
    expect(entries.sort()).toStrictEqual(['alpha', 'gamma']);
    expect(await readFile(join(skillsDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('default/alpha');
    expect(await readFile(join(skillsDir, 'gamma', 'SKILL.md'), 'utf-8')).toBe('refine/gamma');
  });

  it('install creates the .claude parent directory if absent', async () => {
    await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha' }]);
    // sessionDir has no .claude/ yet — install must mkdir -p
    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r = await copier.install(sessionDir, 'refine');
    expect(r.ok).toBe(true);
    expect(existsSync(join(sessionDir, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
  });

  it('install skips a skill that already exists at the destination (project precedence)', async () => {
    await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha', body: 'bundled-version' }]);

    // Project authored its own `alpha` skill at the destination.
    const projectAlpha = join(sessionDir, SKILLS_SUBDIR, 'alpha');
    await mkdir(projectAlpha, { recursive: true });
    await writeFile(join(projectAlpha, 'SKILL.md'), 'project-version', 'utf-8');

    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r = await copier.install(sessionDir, 'refine');
    expect(r.ok).toBe(true);

    // Project copy unchanged — bundled was NOT written over it.
    expect(await readFile(join(projectAlpha, 'SKILL.md'), 'utf-8')).toBe('project-version');

    // Uninstall must NOT remove the project copy.
    const u = await copier.uninstall(sessionDir);
    expect(u.ok).toBe(true);
    expect(existsSync(join(projectAlpha, 'SKILL.md'))).toBe(true);
    expect(await readFile(join(projectAlpha, 'SKILL.md'), 'utf-8')).toBe('project-version');
  });

  it('uninstall removes only what install installed; project skills survive', async () => {
    await materialiseBundledRoot(bundledDir, [
      { phase: 'default', name: 'alpha' },
      { phase: 'plan', name: 'beta' },
    ]);

    // Project authored a third, unrelated skill alongside.
    const projectGamma = join(sessionDir, SKILLS_SUBDIR, 'gamma');
    await mkdir(projectGamma, { recursive: true });
    await writeFile(join(projectGamma, 'SKILL.md'), 'project-only', 'utf-8');

    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r = await copier.install(sessionDir, 'plan');
    expect(r.ok).toBe(true);

    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'alpha'))).toBe(true);
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'beta'))).toBe(true);

    const u = await copier.uninstall(sessionDir);
    expect(u.ok).toBe(true);

    // Bundled gone.
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'alpha'))).toBe(false);
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'beta'))).toBe(false);
    // Project preserved.
    expect(existsSync(join(projectGamma, 'SKILL.md'))).toBe(true);
    // The skills dir itself stays — gamma is still there.
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR))).toBe(true);
  });

  it('uninstall removes the empty .claude/skills/ tree when nothing else lives there', async () => {
    await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha' }]);
    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });

    await copier.install(sessionDir, 'refine');
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'alpha'))).toBe(true);

    const u = await copier.uninstall(sessionDir);
    expect(u.ok).toBe(true);
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR))).toBe(false);
    expect(existsSync(join(sessionDir, '.claude'))).toBe(false);
  });

  it('uninstall is a no-op when nothing was installed (idempotent)', async () => {
    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r = await copier.uninstall(sessionDir);
    expect(r.ok).toBe(true);
  });

  it('uninstall is a no-op on a second call after a successful uninstall', async () => {
    await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha' }]);
    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    await copier.install(sessionDir, 'refine');
    const first = await copier.uninstall(sessionDir);
    expect(first.ok).toBe(true);
    const second = await copier.uninstall(sessionDir);
    expect(second.ok).toBe(true);
  });

  it('two installs (different phases) accumulate, then uninstall clears all bundled but not project', async () => {
    await materialiseBundledRoot(bundledDir, [
      { phase: 'default', name: 'alpha' },
      { phase: 'refine', name: 'beta' },
      { phase: 'plan', name: 'gamma' },
    ]);

    // Pre-existing project skill that must survive.
    const projectDelta = join(sessionDir, SKILLS_SUBDIR, 'delta');
    await mkdir(projectDelta, { recursive: true });
    await writeFile(join(projectDelta, 'SKILL.md'), 'project-only', 'utf-8');

    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r1 = await copier.install(sessionDir, 'refine');
    expect(r1.ok).toBe(true);
    const r2 = await copier.install(sessionDir, 'plan');
    expect(r2.ok).toBe(true);

    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'alpha'))).toBe(true);
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'beta'))).toBe(true);
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'gamma'))).toBe(true);
    expect(existsSync(join(projectDelta, 'SKILL.md'))).toBe(true);

    const u = await copier.uninstall(sessionDir);
    expect(u.ok).toBe(true);

    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'alpha'))).toBe(false);
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'beta'))).toBe(false);
    expect(existsSync(join(sessionDir, SKILLS_SUBDIR, 'gamma'))).toBe(false);
    expect(existsSync(join(projectDelta, 'SKILL.md'))).toBe(true);
  });

  it('a missing phase folder is treated as empty (no error)', async () => {
    await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha' }]);
    // Remove the phase folder entirely — bundle without that phase.
    await rm(join(bundledDir, 'plan'), { recursive: true, force: true });

    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r = await copier.install(sessionDir, 'plan');
    expect(r.ok).toBe(true);
    // Only `default/` skills installed.
    const entries = await readdir(join(sessionDir, SKILLS_SUBDIR));
    expect(entries).toStrictEqual(['alpha']);
  });

  it('an empty phase folder (only .gitkeep) is treated as empty', async () => {
    await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha' }]);
    // Phase folder exists but contains no skill subdirectories.
    await writeFile(join(bundledDir, 'plan', '.gitkeep'), '', 'utf-8');

    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r = await copier.install(sessionDir, 'plan');
    expect(r.ok).toBe(true);
    const entries = await readdir(join(sessionDir, SKILLS_SUBDIR));
    expect(entries).toStrictEqual(['alpha']);
  });

  it('a missing default folder is also tolerated', async () => {
    await materialiseBundledRoot(bundledDir, [{ phase: 'refine', name: 'beta' }]);
    await rm(join(bundledDir, 'default'), { recursive: true, force: true });

    const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
    const r = await copier.install(sessionDir, 'refine');
    expect(r.ok).toBe(true);
    const entries = await readdir(join(sessionDir, SKILLS_SUBDIR));
    expect(entries).toStrictEqual(['beta']);
  });

  // The dirty-tree-after-execute bug: when sessionDir is a git repo (the
  // common single-repo execute case), `commit-task` runs `git add -A`
  // which would otherwise stage the bundled-skills tree and bake them
  // into the user's history. The copier writes a marker block to
  // `.git/info/exclude` at install time and strips it at uninstall time,
  // so `git add -A` never sees the bundled files in the first place.
  describe('local git-exclude lifecycle', () => {
    it('install writes a marker block to <sessionDir>/.git/info/exclude when the dir is a git repo', async () => {
      await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha' }]);
      // Make sessionDir look like a repo root.
      await mkdir(join(sessionDir, '.git'), { recursive: true });

      const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
      const r = await copier.install(sessionDir, 'refine');
      expect(r.ok).toBe(true);

      const excludePath = join(sessionDir, '.git', 'info', 'exclude');
      expect(existsSync(excludePath)).toBe(true);
      const body = await readFile(excludePath, 'utf-8');
      expect(body).toContain('ralphctl-managed-skills');
      expect(body).toContain('.claude/skills/');
    });

    it('uninstall strips the marker block, leaves any user excludes intact', async () => {
      await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha' }]);
      await mkdir(join(sessionDir, '.git', 'info'), { recursive: true });
      const excludePath = join(sessionDir, '.git', 'info', 'exclude');
      await writeFile(excludePath, '# user exclude\n*.bak\n', 'utf-8');

      const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
      await copier.install(sessionDir, 'refine');
      const u = await copier.uninstall(sessionDir);
      expect(u.ok).toBe(true);

      const body = await readFile(excludePath, 'utf-8');
      expect(body).not.toContain('ralphctl-managed-skills');
      expect(body).not.toContain('.claude/skills/');
      expect(body).toContain('# user exclude');
      expect(body).toContain('*.bak');
    });

    it('uninstall cleans up an orphan marker block from a prior crashed run (manifest empty)', async () => {
      await mkdir(join(sessionDir, '.git', 'info'), { recursive: true });
      const excludePath = join(sessionDir, '.git', 'info', 'exclude');
      // Pretend a previous crashed run left the marker behind without a
      // matching uninstall — the copier's in-memory manifest is empty.
      await writeFile(
        excludePath,
        '# >>> ralphctl-managed-skills (do not edit) >>>\n.claude/skills/\n# <<< ralphctl-managed-skills <<<\n',
        'utf-8'
      );

      const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
      const u = await copier.uninstall(sessionDir);
      expect(u.ok).toBe(true);
      const body = await readFile(excludePath, 'utf-8');
      expect(body).not.toContain('ralphctl-managed-skills');
    });

    it('install is a no-op for the exclude file when sessionDir is not a git repo', async () => {
      await materialiseBundledRoot(bundledDir, [{ phase: 'default', name: 'alpha' }]);
      // No `.git/` under sessionDir — typical for refine / plan / ideate
      // workspaces under `<sprintDir>/workspaces/<phase>/`.

      const copier = new FileBundledSkillsCopier({ bundledRootDir: bundledDir });
      const r = await copier.install(sessionDir, 'refine');
      expect(r.ok).toBe(true);
      expect(existsSync(join(sessionDir, '.git'))).toBe(false);
    });
  });
});
