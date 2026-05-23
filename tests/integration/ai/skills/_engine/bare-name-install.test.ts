import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { createClaudeSkillsAdapter } from '@src/integration/ai/skills/claude/adapter.ts';
import { createCodexSkillsAdapter } from '@src/integration/ai/skills/codex/adapter.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';

/**
 * Audit-[09] bare-name install — the {@link SkillsAdapter.installBareSkill} path used by the
 * readiness flow to land AI-authored setup / verify skill bodies. Distinct from the bundled
 * install path: no `ralphctl-` prefix, no `.git/info/exclude` write, no manifest tracking
 * (uninstall leaves it alone).
 *
 * Each test exercises the Claude adapter primarily — the codex / copilot adapters delegate to
 * the same `createFilesystemSkillsAdapter` factory, so a per-provider smoke test on the
 * `parentDir` is enough.
 */

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'bare-skills-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const skill = (name: string, body: string): Skill => ({
  name,
  description: `desc for ${name}`,
  content: body,
});

describe('installBareSkill — claude adapter', () => {
  it('writes <sessionDir>/.claude/skills/<name>/SKILL.md with no ralphctl- prefix', async () => {
    const session = await makeSession();
    const adapter = createClaudeSkillsAdapter();

    const result = await adapter.installBareSkill(session, skill('setup', '# Setup\n\nRun `pnpm install`.\n'));
    expect(result.ok).toBe(true);

    const installed = await readFile(join(String(session), '.claude/skills/setup/SKILL.md'), 'utf-8');
    expect(installed).toContain('name: setup');
    expect(installed).toContain('Run `pnpm install`');

    // No `ralphctl-` prefix folder ever appeared.
    expect(existsSync(join(String(session), '.claude/skills/ralphctl-setup'))).toBe(false);
  });

  it('does NOT touch .git/info/exclude (bare installs are project-tracked)', async () => {
    const session = await makeSession();
    await mkdir(join(String(session), '.git/info'), { recursive: true });
    const beforeExclude = '# pre-existing\n';
    await writeFile(join(String(session), '.git/info/exclude'), beforeExclude, 'utf-8');

    const adapter = createClaudeSkillsAdapter();
    const result = await adapter.installBareSkill(session, skill('setup', '# Setup'));
    expect(result.ok).toBe(true);

    const afterExclude = await readFile(join(String(session), '.git/info/exclude'), 'utf-8');
    expect(afterExclude).toBe(beforeExclude);
    // Specifically — the `.claude/skills/ralphctl-*` wildcard line is NOT appended by this path.
    expect(afterExclude).not.toContain('ralphctl-*');
  });

  it('uninstall leaves bare-installed skills untouched (no manifest tracking)', async () => {
    const session = await makeSession();
    const adapter = createClaudeSkillsAdapter();

    // Install a bare skill, then a regular (bundled) one alongside.
    await adapter.installBareSkill(session, skill('setup', '# bare body'));
    await adapter.install(session, [skill('ralphctl-alignment', '# bundled body')]);

    // Uninstall removes only the manifest-tracked (bundled) entries.
    const uninstall = await adapter.uninstall(session);
    expect(uninstall.ok).toBe(true);

    // The bare skill survives.
    expect(existsSync(join(String(session), '.claude/skills/setup/SKILL.md'))).toBe(true);
    expect(await readFile(join(String(session), '.claude/skills/setup/SKILL.md'), 'utf-8')).toContain('# bare body');
    // The bundled skill is gone.
    expect(existsSync(join(String(session), '.claude/skills/ralphctl-alignment'))).toBe(false);
  });

  it('idempotent — second call with an existing SKILL.md is a no-op (project-wins)', async () => {
    const session = await makeSession();
    const adapter = createClaudeSkillsAdapter();

    await adapter.installBareSkill(session, skill('setup', '# original body'));
    // Second install with a different body must NOT overwrite — the operator may have edited it.
    await adapter.installBareSkill(session, skill('setup', '# overwritten body'));

    const final = await readFile(join(String(session), '.claude/skills/setup/SKILL.md'), 'utf-8');
    expect(final).toContain('# original body');
    expect(final).not.toContain('# overwritten body');
  });

  it('install (bundled) still appends .claude/skills/ralphctl-* line — unchanged path', async () => {
    // Smoke: extending the adapter with `installBareSkill` must not regress the bundled-install
    // behaviour. The wildcard line should still appear on the first bundled install.
    const session = await makeSession();
    await mkdir(join(String(session), '.git/info'), { recursive: true });
    await writeFile(join(String(session), '.git/info/exclude'), '', 'utf-8');

    const adapter = createClaudeSkillsAdapter();
    await adapter.install(session, [skill('ralphctl-alignment', '# A')]);

    const exclude = await readFile(join(String(session), '.git/info/exclude'), 'utf-8');
    expect(exclude).toContain('.claude/skills/ralphctl-*');
  });
});

describe('installBareSkill — codex adapter targets .agents/skills/', () => {
  it('writes <sessionDir>/.agents/skills/<name>/SKILL.md', async () => {
    const session = await makeSession();
    const adapter = createCodexSkillsAdapter();
    const result = await adapter.installBareSkill(session, skill('verify', '# Verify body'));
    expect(result.ok).toBe(true);
    expect(existsSync(join(String(session), '.agents/skills/verify/SKILL.md'))).toBe(true);
  });
});

describe('installBareSkill — copilot adapter targets .github/skills/', () => {
  it('writes <sessionDir>/.github/skills/<name>/SKILL.md', async () => {
    const session = await makeSession();
    const adapter = createCopilotSkillsAdapter();
    const result = await adapter.installBareSkill(session, skill('verify', '# Verify body'));
    expect(result.ok).toBe(true);
    expect(existsSync(join(String(session), '.github/skills/verify/SKILL.md'))).toBe(true);
  });
});
