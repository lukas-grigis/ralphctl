import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { createCodexSkillsAdapter } from '@src/integration/ai/skills/codex/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-skills-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const skill = (name: string, body: string): Skill => ({
  name,
  description: `desc for ${name}`,
  content: body,
});

describe('createCodexSkillsAdapter — install / uninstall', () => {
  it('writes each skill to <sessionDir>/.agents/skills/<name>/SKILL.md', async () => {
    const session = await makeSession();
    const adapter = createCodexSkillsAdapter();
    const result = await adapter.install(session, [skill('alignment', '# A'), skill('iterative-review', '# I')]);
    expect(result.ok).toBe(true);

    const a = await readFile(join(String(session), '.agents/skills/alignment/SKILL.md'), 'utf-8');
    const b = await readFile(join(String(session), '.agents/skills/iterative-review/SKILL.md'), 'utf-8');
    expect(a).toContain('name: alignment');
    expect(a).toContain('# A');
    expect(b).toContain('name: iterative-review');
  });

  it('preserves project-authored skills (project wins)', async () => {
    const session = await makeSession();
    const projectSkill = join(String(session), '.agents/skills/alignment');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT VERSION', 'utf-8');

    const adapter = createCodexSkillsAdapter();
    const result = await adapter.install(session, [skill('alignment', '# bundled')]);
    expect(result.ok).toBe(true);

    expect(await readFile(join(projectSkill, 'SKILL.md'), 'utf-8')).toBe('PROJECT VERSION');
  });

  it('uninstall removes only the skills install created', async () => {
    const session = await makeSession();
    const projectSkill = join(String(session), '.agents/skills/abstraction-first');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT', 'utf-8');

    const adapter = createCodexSkillsAdapter();
    await adapter.install(session, [skill('abstraction-first', 'bundled'), skill('alignment', '# A')]);

    const uninstall = await adapter.uninstall(session);
    expect(uninstall.ok).toBe(true);

    expect(await readFile(join(projectSkill, 'SKILL.md'), 'utf-8')).toBe('PROJECT');
    expect(existsSync(join(String(session), '.agents/skills/alignment'))).toBe(false);
  });

  it('install is idempotent — second call adds only missing skills', async () => {
    const session = await makeSession();
    const adapter = createCodexSkillsAdapter();
    await adapter.install(session, [skill('alignment', '# v1')]);
    const initialMtime = (await stat(join(String(session), '.agents/skills/alignment/SKILL.md'))).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 5));

    await adapter.install(session, [skill('alignment', '# v2 should not overwrite')]);
    const secondMtime = (await stat(join(String(session), '.agents/skills/alignment/SKILL.md'))).mtimeMs;
    expect(secondMtime).toBe(initialMtime);
  });

  it('uninstall tidies empty parent .agents / .agents/skills dirs', async () => {
    const session = await makeSession();
    const adapter = createCodexSkillsAdapter();
    await adapter.install(session, [skill('alignment', '# A')]);
    await adapter.uninstall(session);
    expect(existsSync(join(String(session), '.agents'))).toBe(false);
  });

  it('describeSkillsConvention mentions the .agents/skills path', () => {
    const adapter = createCodexSkillsAdapter();
    expect(adapter.describeSkillsConvention()).toContain('.agents/skills/');
  });
});
