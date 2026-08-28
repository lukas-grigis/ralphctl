import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { createGrokSkillsAdapter } from '@src/integration/ai/skills/grok/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'grok-skills-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const skill = (name: string, body: string): Skill => ({
  name,
  description: `desc for ${name}`,
  content: body,
});

describe('createGrokSkillsAdapter — install', () => {
  it('writes each skill to <sessionDir>/.grok/skills/<name>/SKILL.md', async () => {
    const session = await makeSession();
    const adapter = createGrokSkillsAdapter();
    const result = await adapter.install(session, [skill('alignment', '# A'), skill('iterative-review', '# I')]);
    expect(result.ok).toBe(true);

    const a = await readFile(join(String(session), '.grok/skills/alignment/SKILL.md'), 'utf-8');
    const b = await readFile(join(String(session), '.grok/skills/iterative-review/SKILL.md'), 'utf-8');
    expect(a).toContain('name: alignment');
    expect(a).toContain('# A');
    expect(b).toContain('name: iterative-review');
  });

  it('preserves project-authored skills (project wins)', async () => {
    const session = await makeSession();
    const projectSkill = join(String(session), '.grok/skills/alignment');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT VERSION', 'utf-8');

    const adapter = createGrokSkillsAdapter();
    const result = await adapter.install(session, [skill('alignment', '# bundled')]);
    expect(result.ok).toBe(true);

    expect(await readFile(join(projectSkill, 'SKILL.md'), 'utf-8')).toBe('PROJECT VERSION');
  });

  it('describeSkillsConvention mentions the .grok/skills path', () => {
    const adapter = createGrokSkillsAdapter();
    expect(adapter.describeSkillsConvention()).toContain('.grok/skills/');
  });
});

describe('createGrokSkillsAdapter — .git/info/exclude wildcard', () => {
  it('appends the .grok/skills/ralphctl-* line on first install', async () => {
    const session = await makeSession();
    await mkdir(join(String(session), '.git/info'), { recursive: true });
    await writeFile(join(String(session), '.git/info/exclude'), '# default\n', 'utf-8');

    const adapter = createGrokSkillsAdapter();
    await adapter.install(session, [skill('ralphctl-alignment', '# A')]);

    const content = await readFile(join(String(session), '.git/info/exclude'), 'utf-8');
    expect(content).toContain('.grok/skills/ralphctl-*');
  });
});
