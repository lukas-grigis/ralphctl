import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import type { ResolvedSkill } from '@src/business/ports/skills.ts';
import {
  _activeLinkedSetCountForTests,
  _resetSkillRegistryForTests,
  cleanupSkills,
  linkSkillsForPhase,
  skillsDirFor,
} from './lifecycle.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpinner(): SpinnerHandle {
  return {
    succeed: () => undefined,
    fail: () => undefined,
    stop: () => undefined,
  };
}

interface CapturingLogger extends LoggerPort {
  warnings: string[];
}

function makeLogger(): CapturingLogger {
  const warnings: string[] = [];
  const logger: CapturingLogger = {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    warning: (msg: string) => {
      warnings.push(msg);
    },
    tip: () => undefined,
    header: () => undefined,
    separator: () => undefined,
    field: () => undefined,
    card: () => undefined,
    newline: () => undefined,
    dim: () => undefined,
    item: () => undefined,
    spinner: () => makeSpinner(),
    child: () => logger,
    time: () => () => undefined,
  };
  return logger;
}

async function makeSourceSkill(root: string, dir: string, name: string): Promise<ResolvedSkill> {
  const sourcePath = join(root, dir);
  await mkdir(sourcePath, { recursive: true });
  await writeFile(
    join(sourcePath, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}-desc\n---\n\nBody for ${name}.\n`
  );
  // Add a supporting file so we can verify the symlink points at the *directory*
  // and not just the SKILL.md.
  await writeFile(join(sourcePath, 'reference.md'), `Reference for ${name}.\n`);
  return { name, description: `${name}-desc`, sourcePath, origin: 'builtin' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('linkSkillsForPhase + cleanupSkills', () => {
  let sourceRoot: string;
  let workingDir: string;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'ralph-skills-src-'));
    workingDir = await mkdtemp(join(tmpdir(), 'ralph-skills-work-'));
  });

  afterEach(async () => {
    _resetSkillRegistryForTests();
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(workingDir, { recursive: true, force: true });
  });

  it('creates one symlink per skill at <workingDir>/.claude/skills/<name>', async () => {
    const a = await makeSourceSkill(sourceRoot, 'a', 'a-skill');
    const b = await makeSourceSkill(sourceRoot, 'b', 'b-skill');
    const set = await linkSkillsForPhase(workingDir, [a, b]);
    expect([...set.linkedNames].sort()).toEqual(['a-skill', 'b-skill']);

    const linkA = join(skillsDirFor(workingDir), 'a-skill');
    const linkB = join(skillsDirFor(workingDir), 'b-skill');
    const targetA = await readlink(linkA);
    const targetB = await readlink(linkB);
    expect(targetA).toBe(a.sourcePath);
    expect(targetB).toBe(b.sourcePath);

    // Reading SKILL.md through the symlink resolves to the source content.
    const content = await readFile(join(linkA, 'SKILL.md'), 'utf-8');
    expect(content).toContain('a-skill');
  });

  it('creates the .claude/skills/ parent on demand', async () => {
    const a = await makeSourceSkill(sourceRoot, 'a', 'a-skill');
    await linkSkillsForPhase(workingDir, [a]);
    const stats = await lstat(skillsDirFor(workingDir));
    expect(stats.isDirectory()).toBe(true);
  });

  it('cleanup removes every symlink it created and leaves source skill dirs untouched', async () => {
    const a = await makeSourceSkill(sourceRoot, 'a', 'a-skill');
    const b = await makeSourceSkill(sourceRoot, 'b', 'b-skill');
    const set = await linkSkillsForPhase(workingDir, [a, b]);

    await cleanupSkills(set);

    const skillsDir = skillsDirFor(workingDir);
    const remaining = await readdir(skillsDir);
    expect(remaining).toEqual([]);

    // Source skill dirs must still hold their original files.
    const sourceA = await readdir(a.sourcePath);
    expect(sourceA.sort()).toEqual(['SKILL.md', 'reference.md']);
  });

  it('cleanup is idempotent — second call is a no-op', async () => {
    const a = await makeSourceSkill(sourceRoot, 'a', 'a-skill');
    const set = await linkSkillsForPhase(workingDir, [a]);

    await cleanupSkills(set);
    await cleanupSkills(set);

    const skillsDir = skillsDirFor(workingDir);
    const remaining = await readdir(skillsDir);
    expect(remaining).toEqual([]);
  });

  it('rebinds an existing symlink to the new source path on re-link', async () => {
    const a1 = await makeSourceSkill(sourceRoot, 'first', 'a-skill');
    await linkSkillsForPhase(workingDir, [a1]);

    // New source path with the same skill name (e.g. user upgraded the skill).
    const a2 = await makeSourceSkill(sourceRoot, 'second', 'a-skill');
    const set2 = await linkSkillsForPhase(workingDir, [a2]);

    expect(set2.linkedNames).toEqual(['a-skill']);
    const target = await readlink(join(skillsDirFor(workingDir), 'a-skill'));
    expect(target).toBe(a2.sourcePath);
  });

  it('refuses to overwrite a non-symlink at the same path and warns', async () => {
    const a = await makeSourceSkill(sourceRoot, 'a', 'a-skill');
    // Pre-create a real directory at the link path — simulates a user file.
    await mkdir(join(skillsDirFor(workingDir), 'a-skill'), { recursive: true });
    const logger = makeLogger();
    const set = await linkSkillsForPhase(workingDir, [a], logger);
    expect(set.linkedNames).toEqual([]);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('a-skill');
  });

  it('drops the registry entry on cleanup so the exit handler has nothing to do', async () => {
    const baseline = _activeLinkedSetCountForTests();
    const a = await makeSourceSkill(sourceRoot, 'a', 'a-skill');
    const set = await linkSkillsForPhase(workingDir, [a]);
    expect(_activeLinkedSetCountForTests()).toBe(baseline + 1);
    await cleanupSkills(set);
    expect(_activeLinkedSetCountForTests()).toBe(baseline);
  });

  it('produces the same linked set for two working dirs sharing the same source skills (generator + evaluator parity)', async () => {
    const skills = [await makeSourceSkill(sourceRoot, 's', 'shared-skill')];
    const dirA = await mkdtemp(join(tmpdir(), 'ralph-skills-genA-'));
    const dirB = await mkdtemp(join(tmpdir(), 'ralph-skills-genB-'));
    try {
      const setA = await linkSkillsForPhase(dirA, skills);
      const setB = await linkSkillsForPhase(dirB, skills);
      expect(setA.linkedNames).toEqual(setB.linkedNames);
      const tA = await readlink(join(skillsDirFor(dirA), 'shared-skill'));
      const tB = await readlink(join(skillsDirFor(dirB), 'shared-skill'));
      expect(tA).toBe(tB);

      // Identical SKILL.md content via either link — generator and evaluator
      // see the same body when both spawn with the same cwd contract.
      const ca = await readFile(join(skillsDirFor(dirA), 'shared-skill', 'SKILL.md'), 'utf-8');
      const cb = await readFile(join(skillsDirFor(dirB), 'shared-skill', 'SKILL.md'), 'utf-8');
      expect(ca).toBe(cb);
      await cleanupSkills(setA);
      await cleanupSkills(setB);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });
});
