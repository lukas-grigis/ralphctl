import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillNameCollisionError } from '@src/domain/errors.ts';
import type { LoggerPort, SpinnerHandle } from '@src/business/ports/logger.ts';
import { loadSkillsForPhase, parseSkillFrontmatter } from './loader.ts';

// ---------------------------------------------------------------------------
// Test helpers
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

async function writeSkill(root: string, phase: string, dirName: string, body: string): Promise<string> {
  const dir = join(root, phase, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), body);
  return dir;
}

const VALID = (name: string, description = 'desc') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`;

// ---------------------------------------------------------------------------
// parseSkillFrontmatter
// ---------------------------------------------------------------------------

describe('parseSkillFrontmatter', () => {
  it('extracts name + description from a valid SKILL.md', () => {
    const fm = parseSkillFrontmatter(VALID('my-skill', 'Does X'));
    expect(fm).toEqual({ name: 'my-skill', description: 'Does X' });
  });

  it('strips surrounding quotes from values', () => {
    const fm = parseSkillFrontmatter(`---\nname: "quoted"\ndescription: 'with quotes'\n---\nbody`);
    expect(fm).toEqual({ name: 'quoted', description: 'with quotes' });
  });

  it('tolerates a UTF-8 BOM at the start of the document', () => {
    const fm = parseSkillFrontmatter('﻿' + VALID('bom-skill'));
    expect(fm?.name).toBe('bom-skill');
  });

  it('returns null when the document does not start with a fence', () => {
    expect(parseSkillFrontmatter('# No frontmatter\n\nbody')).toBeNull();
  });

  it('returns null when the closing fence is missing', () => {
    expect(parseSkillFrontmatter('---\nname: x\ndescription: y\nno end\n')).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(parseSkillFrontmatter('---\ndescription: only\n---\nbody')).toBeNull();
  });

  it('returns null when description is missing', () => {
    expect(parseSkillFrontmatter('---\nname: only\n---\nbody')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadSkillsForPhase
// ---------------------------------------------------------------------------

describe('loadSkillsForPhase', () => {
  let builtinRoot: string;
  let userRoot: string;
  let logger: CapturingLogger;

  beforeEach(async () => {
    builtinRoot = await mkdtemp(join(tmpdir(), 'ralph-skills-builtin-'));
    userRoot = await mkdtemp(join(tmpdir(), 'ralph-skills-user-'));
    logger = makeLogger();
  });

  afterEach(async () => {
    await rm(builtinRoot, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  });

  it('returns built-in skills when no user tree exists', async () => {
    await writeSkill(builtinRoot, 'refine', 'a-skill', VALID('a-skill'));
    const skills = await loadSkillsForPhase('refine', { builtinRoot, userRoot, logger });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('a-skill');
    expect(skills[0]?.origin).toBe('builtin');
  });

  it('treats a missing user root as empty (not an error)', async () => {
    await writeSkill(builtinRoot, 'plan', 'b-skill', VALID('b-skill'));
    const skills = await loadSkillsForPhase('plan', {
      builtinRoot,
      userRoot: join(userRoot, 'definitely-missing'),
      logger,
    });
    expect(skills.map((s) => s.name)).toEqual(['b-skill']);
    expect(logger.warnings).toEqual([]);
  });

  it('returns the union of built-in + user skills', async () => {
    await writeSkill(builtinRoot, 'plan', 'b-skill', VALID('b-skill'));
    await writeSkill(userRoot, 'plan', 'my-skill', VALID('my-skill'));
    const skills = await loadSkillsForPhase('plan', { builtinRoot, userRoot, logger });
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['b-skill', 'my-skill']);
    const userOne = skills.find((s) => s.name === 'my-skill');
    expect(userOne?.origin).toBe('user');
  });

  it('only loads skills for the requested phase', async () => {
    await writeSkill(builtinRoot, 'refine', 'r-skill', VALID('r-skill'));
    await writeSkill(builtinRoot, 'plan', 'p-skill', VALID('p-skill'));
    await writeSkill(builtinRoot, 'exec', 'e-skill', VALID('e-skill'));
    const refine = await loadSkillsForPhase('refine', { builtinRoot, userRoot, logger });
    expect(refine.map((s) => s.name)).toEqual(['r-skill']);
  });

  it('merges default/ skills into every phase', async () => {
    await writeSkill(builtinRoot, 'default', 'cross-phase', VALID('cross-phase'));
    await writeSkill(builtinRoot, 'refine', 'r-skill', VALID('r-skill'));
    await writeSkill(builtinRoot, 'plan', 'p-skill', VALID('p-skill'));
    await writeSkill(builtinRoot, 'exec', 'e-skill', VALID('e-skill'));

    const refine = await loadSkillsForPhase('refine', { builtinRoot, userRoot, logger });
    const plan = await loadSkillsForPhase('plan', { builtinRoot, userRoot, logger });
    const exec = await loadSkillsForPhase('exec', { builtinRoot, userRoot, logger });

    expect(refine.map((s) => s.name).sort()).toEqual(['cross-phase', 'r-skill']);
    expect(plan.map((s) => s.name).sort()).toEqual(['cross-phase', 'p-skill']);
    expect(exec.map((s) => s.name).sort()).toEqual(['cross-phase', 'e-skill']);
  });

  it('merges user default/ skills into every phase alongside built-in defaults', async () => {
    await writeSkill(builtinRoot, 'default', 'cross-phase', VALID('cross-phase'));
    await writeSkill(userRoot, 'default', 'my-default', VALID('my-default'));

    const refine = await loadSkillsForPhase('refine', { builtinRoot, userRoot, logger });
    const names = refine.map((s) => s.name).sort();
    expect(names).toEqual(['cross-phase', 'my-default']);

    const userOne = refine.find((s) => s.name === 'my-default');
    expect(userOne?.origin).toBe('user');
  });

  it('throws when a default/ skill collides with a phase-scoped skill', async () => {
    await writeSkill(builtinRoot, 'default', 'a', VALID('shared'));
    await writeSkill(builtinRoot, 'plan', 'b', VALID('shared'));
    await expect(loadSkillsForPhase('plan', { builtinRoot, userRoot, logger })).rejects.toBeInstanceOf(
      SkillNameCollisionError
    );
  });

  it('ignores loose files alongside skill directories under default/', async () => {
    await writeSkill(builtinRoot, 'default', 'cross-phase', VALID('cross-phase'));
    // A flat governance doc next to the skill directory must not become a candidate.
    const looseFile = join(builtinRoot, 'default', 'norms.md');
    await writeFile(looseFile, '# norms\n');

    const refine = await loadSkillsForPhase('refine', { builtinRoot, userRoot, logger });
    expect(refine.map((s) => s.name)).toEqual(['cross-phase']);
    expect(logger.warnings).toEqual([]);
  });

  it('throws SkillNameCollisionError when built-in and user share a name (both paths in error)', async () => {
    const builtinPath = await writeSkill(builtinRoot, 'refine', 'shared', VALID('foo'));
    const userPath = await writeSkill(userRoot, 'refine', 'also-shared', VALID('foo'));
    await expect(loadSkillsForPhase('refine', { builtinRoot, userRoot, logger })).rejects.toMatchObject({
      name: 'SkillNameCollisionError',
      skillName: 'foo',
      sourcePaths: expect.arrayContaining([builtinPath, userPath]) as readonly string[],
    });
  });

  it('throws when two user skills declare the same name', async () => {
    await writeSkill(userRoot, 'plan', 'a', VALID('dup'));
    await writeSkill(userRoot, 'plan', 'b', VALID('dup'));
    await expect(loadSkillsForPhase('plan', { builtinRoot, userRoot, logger })).rejects.toBeInstanceOf(
      SkillNameCollisionError
    );
  });

  it('skips invalid skills with a warning identifying the path and reason', async () => {
    const goodPath = await writeSkill(builtinRoot, 'refine', 'good', VALID('good'));
    const brokenPath = await writeSkill(builtinRoot, 'refine', 'broken', '# no frontmatter\nbody only\n');
    const skills = await loadSkillsForPhase('refine', { builtinRoot, userRoot, logger });
    expect(skills.map((s) => s.name)).toEqual(['good']);
    expect(skills[0]?.sourcePath).toBe(goodPath);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain(brokenPath);
    expect(logger.warnings[0]).toContain('frontmatter');
  });

  it('skips a skill directory that has no SKILL.md at all', async () => {
    const dir = join(builtinRoot, 'refine', 'naked-dir');
    await mkdir(dir, { recursive: true });
    const skills = await loadSkillsForPhase('refine', { builtinRoot, userRoot, logger });
    expect(skills).toEqual([]);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('SKILL.md is missing');
  });

  it('continues with valid skills when a sibling is invalid', async () => {
    await writeSkill(builtinRoot, 'exec', 'good', VALID('good'));
    await writeSkill(builtinRoot, 'exec', 'broken', 'no frontmatter');
    await writeSkill(userRoot, 'exec', 'extra', VALID('extra'));
    const skills = await loadSkillsForPhase('exec', { builtinRoot, userRoot, logger });
    expect(skills.map((s) => s.name).sort()).toEqual(['extra', 'good']);
  });
});
