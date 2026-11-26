import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBundledSkillRawReader,
  createBundledSkillSource,
  resolveBundledRoot,
} from '@src/integration/ai/skills/bundled/source.ts';
import { BUNDLED_SKILLS, skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';

describe('resolveBundledRoot', () => {
  it('resolves the co-located skills/ dir when the build copied SKILL.md folders beside the bundle', () => {
    // What decides it is the skills/ dir sitting beside the module — NOT the artifact filename.
    // A hashed `cli-<hash>.mjs` code-split chunk (which the 0.15.0 filename check missed) resolves
    // identically to the `cli.mjs` entry stub.
    const beside = (p: string): boolean => p === '/pkg/dist/skills';
    expect(resolveBundledRoot('file:///pkg/dist/cli-CKPJ5SY4.mjs', beside)).toBe('/pkg/dist/skills');
    expect(resolveBundledRoot('file:///pkg/dist/cli.mjs', beside)).toBe('/pkg/dist/skills');
  });

  it('resolves the module dir itself in dev, where nothing sits beside source.ts', () => {
    const never = (): boolean => false;
    expect(resolveBundledRoot('file:///pkg/src/integration/ai/skills/bundled/source.ts', never)).toBe(
      '/pkg/src/integration/ai/skills/bundled'
    );
  });
});

describe('createBundledSkillSource (production root)', () => {
  // Hits the real `src/integration/ai/skills/bundled/` folder.
  const source = createBundledSkillSource();

  it('loads bundled skills for the implement flow', async () => {
    const result = await source.getForFlow('implement');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.map((s) => s.name);
    expect(names).toContain('ralphctl-ponytail');
    expect(names).toContain('ralphctl-test-driven-development');
  });

  it('reads name + description from frontmatter', async () => {
    const result = await source.getForFlow('plan');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ponytail = result.value.find((s) => s.name === 'ralphctl-ponytail');
    expect(ponytail?.name).toBe('ralphctl-ponytail');
    expect(ponytail?.description.length).toBeGreaterThan(0);
    expect(ponytail?.content).toContain('# Ponytail');
  });

  it('returns exactly the registry defaults for each flow, in table order', async () => {
    for (const flowId of FLOW_IDS) {
      const result = await source.getForFlow(flowId);
      expect(result.ok, flowId).toBe(true);
      if (!result.ok) return;
      expect(result.value.map((s) => s.name)).toEqual(skillsForFlow(flowId));
    }
  });

  it('getByName resolves a known bundled skill by its exact folder name', async () => {
    const result = await source.getByName('ralphctl-ponytail');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.name).toBe('ralphctl-ponytail');
    expect(result.value?.content).toContain('# Ponytail');
  });

  it('loads ralphctl-writing-for-agents into the readiness flow', async () => {
    const result = await source.getForFlow('readiness');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.name)).toContain('ralphctl-writing-for-agents');
  });

  it('parses every catalog row, including the opt-in-only skills no flow loads by default', async () => {
    // getForFlow never touches a default-OFF skill, so a broken one would surface only when an
    // operator enables it from the catalog.
    for (const { name } of BUNDLED_SKILLS) {
      const result = await source.getByName(name);
      expect(result.ok, `${name} failed to parse`).toBe(true);
      if (!result.ok) return;
      expect(result.value?.name).toBe(name);
      expect(result.value?.description.length).toBeGreaterThan(0);
    }
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
    // Empty root — the source will look up plan's defaults and fail to read.
    const source = createBundledSkillSource({ bundledRoot: root });
    const result = await source.getForFlow('plan');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/bundled skill not readable/u);
  });

  it('rejects malformed frontmatter with a parse error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
    // plan's only default is ponytail; its frontmatter is missing the required `name` field.
    const skillDir = join(root, 'ralphctl-ponytail');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\ndescription: only description\n---\n\n# body\n', 'utf-8');
    const source = createBundledSkillSource({ bundledRoot: root });
    const result = await source.getForFlow('plan');
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

  it('getByName surfaces a StorageError when the SKILL.md path is present but unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
    // Make `<root>/wedged-skill/SKILL.md` a DIRECTORY, not a file. The async read fails with a
    // non-ENOENT error (EISDIR), which must propagate as a StorageError — not collapse to the
    // unknown-name (undefined) case the way a genuinely missing file does.
    await mkdir(join(root, 'wedged-skill', 'SKILL.md'), { recursive: true });
    const source = createBundledSkillSource({ bundledRoot: root });
    const result = await source.getByName('wedged-skill');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/bundled skill not readable/u);
  });

  it('requires frontmatter name to match the folder name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
    const dir = join(root, 'ralphctl-ponytail');
    await mkdir(dir, { recursive: true });
    // Frontmatter name does not match the folder ('ralphctl-ponytail' vs. 'mismatch').
    await writeFile(join(dir, 'SKILL.md'), `---\nname: mismatch\ndescription: ok\n---\n\nbody\n`, 'utf-8');
    const source = createBundledSkillSource({ bundledRoot: root });
    const result = await source.getForFlow('plan');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/must match folder name/u);
  });
});

describe('createBundledSkillSource — folder skills', () => {
  it('getByName returns the support files beside SKILL.md, and the raw reader hands the catalog the same folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-source-'));
    const dir = join(root, 'ralphctl-folder');
    await mkdir(join(dir, 'references'), { recursive: true });
    const skillMd = '---\nname: ralphctl-folder\ndescription: folder skill\n---\n\nSee references/x.md.\n';
    await writeFile(join(dir, 'SKILL.md'), skillMd, 'utf-8');
    await writeFile(join(dir, 'references', 'x.md'), '# x\n', 'utf-8');

    const result = await createBundledSkillSource({ bundledRoot: root }).getByName('ralphctl-folder');
    expect(result.ok && result.value?.files).toEqual([{ path: 'references/x.md', content: '# x\n' }]);

    const raw = await createBundledSkillRawReader({ bundledRoot: root }).readFolder('ralphctl-folder');
    expect(raw.ok && raw.value).toEqual({ skillMd, files: [{ path: 'references/x.md', content: '# x\n' }] });
  });
});
