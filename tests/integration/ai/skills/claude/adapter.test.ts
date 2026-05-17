import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { createClaudeSkillsAdapter } from '@src/integration/ai/skills/claude/adapter.ts';

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-skills-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const skill = (name: string, body: string): Skill => ({
  name,
  description: `desc for ${name}`,
  content: body,
});

describe('createClaudeSkillsAdapter — install / uninstall', () => {
  it('writes each skill to <sessionDir>/.claude/skills/<name>/SKILL.md', async () => {
    const session = await makeSession();
    const adapter = createClaudeSkillsAdapter();
    const result = await adapter.install(session, [skill('alignment', '# A'), skill('iterative-review', '# I')]);
    expect(result.ok).toBe(true);

    const a = await readFile(join(String(session), '.claude/skills/alignment/SKILL.md'), 'utf-8');
    const b = await readFile(join(String(session), '.claude/skills/iterative-review/SKILL.md'), 'utf-8');
    expect(a).toContain('name: alignment');
    expect(a).toContain('# A');
    expect(b).toContain('name: iterative-review');
  });

  it('preserves project-authored skills (project wins)', async () => {
    const session = await makeSession();
    const projectSkill = join(String(session), '.claude/skills/alignment');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT VERSION', 'utf-8');

    const adapter = createClaudeSkillsAdapter();
    const result = await adapter.install(session, [skill('alignment', '# bundled')]);
    expect(result.ok).toBe(true);

    const content = await readFile(join(projectSkill, 'SKILL.md'), 'utf-8');
    // The bundled copy is skipped — project version stays untouched.
    expect(content).toBe('PROJECT VERSION');
  });

  it('uninstall removes only the skills install created', async () => {
    const session = await makeSession();
    const projectSkill = join(String(session), '.claude/skills/abstraction-first');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(join(projectSkill, 'SKILL.md'), 'PROJECT', 'utf-8');

    const adapter = createClaudeSkillsAdapter();
    await adapter.install(session, [skill('abstraction-first', 'bundled'), skill('alignment', '# A')]);

    const uninstall = await adapter.uninstall(session);
    expect(uninstall.ok).toBe(true);

    // Project skill is still there.
    expect(await readFile(join(projectSkill, 'SKILL.md'), 'utf-8')).toBe('PROJECT');
    // Bundled skill we created is gone.
    expect(existsSync(join(String(session), '.claude/skills/alignment'))).toBe(false);
  });

  it('uninstall is a no-op when nothing was installed', async () => {
    const session = await makeSession();
    const adapter = createClaudeSkillsAdapter();
    const result = await adapter.uninstall(session);
    expect(result.ok).toBe(true);
  });

  it('install is idempotent — second call adds only missing skills', async () => {
    const session = await makeSession();
    const adapter = createClaudeSkillsAdapter();
    await adapter.install(session, [skill('alignment', '# v1')]);
    const initialMtime = (await stat(join(String(session), '.claude/skills/alignment/SKILL.md'))).mtimeMs;

    // Wait a tick so mtime would differ if rewritten.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await adapter.install(session, [skill('alignment', '# v2 should not overwrite')]);
    const secondMtime = (await stat(join(String(session), '.claude/skills/alignment/SKILL.md'))).mtimeMs;
    expect(secondMtime).toBe(initialMtime);
  });

  it('uninstall tidies empty parent .claude / .claude/skills dirs', async () => {
    const session = await makeSession();
    const adapter = createClaudeSkillsAdapter();
    await adapter.install(session, [skill('alignment', '# A')]);
    await adapter.uninstall(session);
    expect(existsSync(join(String(session), '.claude'))).toBe(false);
  });

  it('preserves a non-empty .claude when other content lives there', async () => {
    const session = await makeSession();
    // User has a project-level CLAUDE.md sitting next to where skills/ would go.
    await mkdir(join(String(session), '.claude'), { recursive: true });
    await writeFile(join(String(session), '.claude/CLAUDE.md'), '# project memory', 'utf-8');

    const adapter = createClaudeSkillsAdapter();
    await adapter.install(session, [skill('alignment', '# A')]);
    await adapter.uninstall(session);

    // Skills folder gone; user file preserved.
    expect(existsSync(join(String(session), '.claude/skills'))).toBe(false);
    expect(existsSync(join(String(session), '.claude/CLAUDE.md'))).toBe(true);
  });
});
