import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundledSkillSource } from '@src/integration/ai/skills/bundled/source.ts';

describe('createBundledSkillSource (production root)', () => {
  // Hits the real `src/ai/skills/bundled/` folder. Asserts the three v1 skills load.
  const source = createBundledSkillSource();

  it('loads bundled skills for the refine flow', async () => {
    const result = await source.getForFlow('refine');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.map((s) => s.name);
    expect(names).toContain('ralphctl-alignment');
    expect(names).toContain('ralphctl-abstraction-first');
    expect(names).toContain('ralphctl-iterative-review');
  });

  it('reads name + description from frontmatter', async () => {
    const result = await source.getForFlow('refine');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alignment = result.value.find((s) => s.name === 'ralphctl-alignment');
    expect(alignment?.name).toBe('ralphctl-alignment');
    expect(alignment?.description.length).toBeGreaterThan(0);
    expect(alignment?.content).toContain('# Alignment');
  });

  it('returns the same set across flows (current registry assigns all skills to all flows)', async () => {
    const a = await source.getForFlow('refine');
    const b = await source.getForFlow('plan');
    expect(a.ok && b.ok).toBe(true);
    if (!(a.ok && b.ok)) return;
    expect(a.value.map((s) => s.name)).toEqual(b.value.map((s) => s.name));
  });

  it('getByName resolves a known bundled skill by its exact folder name', async () => {
    const result = await source.getByName('ralphctl-alignment');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.name).toBe('ralphctl-alignment');
    expect(result.value?.content).toContain('# Alignment');
  });

  it('getByName returns ok(undefined) for an unknown name (not an error)', async () => {
    const result = await source.getByName('react-patterns');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });
});

describe('createBundledSkillSource (custom root)', () => {
  it('errors out cleanly when a referenced skill folder is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
    // Empty root — the source will look up alignment etc and fail to read.
    const source = createBundledSkillSource({ bundledRoot: root });
    const result = await source.getForFlow('refine');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/bundled skill not readable/u);
  });

  it('rejects malformed frontmatter with a parse error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
    const skillDir = join(root, 'ralphctl-alignment');
    await mkdir(skillDir, { recursive: true });
    // Frontmatter missing the required `name` field.
    await writeFile(join(skillDir, 'SKILL.md'), '---\ndescription: only description\n---\n\n# body\n', 'utf-8');
    // Need the other two too so the loop reaches alignment cleanly.
    for (const id of ['ralphctl-abstraction-first', 'ralphctl-iterative-review']) {
      const dir = join(root, id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ok\n---\nbody\n`, 'utf-8');
    }
    const source = createBundledSkillSource({ bundledRoot: root });
    const result = await source.getForFlow('refine');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/invalid frontmatter/u);
  });

  it('getByName surfaces a StorageError when a present skill has malformed frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
    const skillDir = join(root, 'broken-skill');
    await mkdir(skillDir, { recursive: true });
    // File exists (so it is "known") but frontmatter is missing the required `name`.
    await writeFile(join(skillDir, 'SKILL.md'), '---\ndescription: only description\n---\n\n# body\n', 'utf-8');
    const source = createBundledSkillSource({ bundledRoot: root });
    const result = await source.getByName('broken-skill');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/invalid frontmatter/u);
  });

  it('requires frontmatter name to match the folder name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
    const alignDir = join(root, 'ralphctl-alignment');
    await mkdir(alignDir, { recursive: true });
    // Frontmatter name does not match the folder ('ralphctl-alignment' vs. 'mismatch').
    await writeFile(join(alignDir, 'SKILL.md'), `---\nname: mismatch\ndescription: ok\n---\n\nbody\n`, 'utf-8');
    for (const name of ['ralphctl-abstraction-first', 'ralphctl-iterative-review']) {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ok\n---\nbody\n`, 'utf-8');
    }
    const source = createBundledSkillSource({ bundledRoot: root });
    const result = await source.getForFlow('refine');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/must match folder name/u);
  });
});
