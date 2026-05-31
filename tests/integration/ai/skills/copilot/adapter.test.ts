import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-skills-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const skill = (name: string, body: string): Skill => ({
  name,
  description: `desc for ${name}`,
  content: body,
});

describe('createCopilotSkillsAdapter — install / uninstall', () => {
  it('writes each skill to <sessionDir>/.github/skills/<name>/SKILL.md', async () => {
    const session = await makeSession();
    const adapter = createCopilotSkillsAdapter();
    const result = await adapter.install(session, [skill('alignment', '# A'), skill('iterative-review', '# I')]);
    expect(result.ok).toBe(true);

    const a = await readFile(join(String(session), '.github/skills/alignment/SKILL.md'), 'utf-8');
    const b = await readFile(join(String(session), '.github/skills/iterative-review/SKILL.md'), 'utf-8');
    expect(a).toContain('name: alignment');
    expect(a).toContain('# A');
    expect(b).toContain('name: iterative-review');
  });

  it('preserves project-authored skills (project wins)', async () => {
    const session = await makeSession();
    const projectSkill = join(String(session), '.github/skills/alignment');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT VERSION', 'utf-8');

    const adapter = createCopilotSkillsAdapter();
    const result = await adapter.install(session, [skill('alignment', '# bundled')]);
    expect(result.ok).toBe(true);

    expect(await readFile(join(projectSkill, 'SKILL.md'), 'utf-8')).toBe('PROJECT VERSION');
  });

  it('uninstall removes only the skills install created', async () => {
    const session = await makeSession();
    const projectSkill = join(String(session), '.github/skills/abstraction-first');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT', 'utf-8');

    const adapter = createCopilotSkillsAdapter();
    await adapter.install(session, [skill('abstraction-first', 'bundled'), skill('alignment', '# A')]);

    const uninstall = await adapter.uninstall(session);
    expect(uninstall.ok).toBe(true);

    expect(await readFile(join(projectSkill, 'SKILL.md'), 'utf-8')).toBe('PROJECT');
    expect(existsSync(join(String(session), '.github/skills/alignment'))).toBe(false);
  });

  it('install is idempotent — second call adds only missing skills', async () => {
    const session = await makeSession();
    const adapter = createCopilotSkillsAdapter();
    await adapter.install(session, [skill('alignment', '# v1')]);
    const initialMtime = (await stat(join(String(session), '.github/skills/alignment/SKILL.md'))).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 5));

    await adapter.install(session, [skill('alignment', '# v2 should not overwrite')]);
    const secondMtime = (await stat(join(String(session), '.github/skills/alignment/SKILL.md'))).mtimeMs;
    expect(secondMtime).toBe(initialMtime);
  });

  it('preserves a non-empty .github when other content lives there', async () => {
    const session = await makeSession();
    // A typical repo has workflows or PR templates under .github already.
    await mkdir(join(String(session), '.github/workflows'), { recursive: true });
    await writeFile(join(String(session), '.github/workflows/ci.yml'), '# ci', 'utf-8');

    const adapter = createCopilotSkillsAdapter();
    await adapter.install(session, [skill('alignment', '# A')]);
    await adapter.uninstall(session);

    // Skills folder gone; user's workflows directory preserved.
    expect(existsSync(join(String(session), '.github/skills'))).toBe(false);
    expect(existsSync(join(String(session), '.github/workflows/ci.yml'))).toBe(true);
  });

  it('describeSkillsConvention mentions the .github/skills path', () => {
    const adapter = createCopilotSkillsAdapter();
    expect(adapter.describeSkillsConvention()).toContain('.github/skills/');
  });
});
