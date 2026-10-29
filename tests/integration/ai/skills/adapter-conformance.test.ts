import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import { createClaudeSkillsAdapter } from '@src/integration/ai/skills/claude/adapter.ts';
import { createCodexSkillsAdapter } from '@src/integration/ai/skills/codex/adapter.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';
import { createGrokSkillsAdapter } from '@src/integration/ai/skills/grok/adapter.ts';
import { createOpencodeSkillsAdapter } from '@src/integration/ai/skills/opencode/adapter.ts';

/**
 * The per-provider skills adapters are thin wrappers over `createFilesystemSkillsAdapter`; only the
 * parent directory and the convention prose differ. One row per provider pins that each wrapper
 * wires the shared behaviour onto its own directory.
 */
const ROWS: ReadonlyArray<{ readonly provider: AiProvider; readonly create: () => SkillsAdapter }> = [
  { provider: 'claude-code', create: createClaudeSkillsAdapter },
  { provider: 'openai-codex', create: createCodexSkillsAdapter },
  { provider: 'github-copilot', create: createCopilotSkillsAdapter },
  { provider: 'xai-grok', create: createGrokSkillsAdapter },
  { provider: 'opencode', create: createOpencodeSkillsAdapter },
];

const sessionDirs: string[] = [];

afterEach(async () => {
  for (const dir of sessionDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-conformance-'));
  sessionDirs.push(dir);
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const skill = (name: string, body: string): Skill => ({ name, description: `desc for ${name}`, content: body });

describe.each(ROWS)('$provider skills adapter', ({ provider, create }) => {
  const parentDir = PROVIDER_TRAITS[provider].skillsParentDir;
  const skillsDir = `${parentDir}/skills`;
  const at = (session: AbsolutePath, ...parts: string[]): string => join(String(session), ...parts);

  it(`writes each skill to <sessionDir>/${skillsDir}/<name>/SKILL.md`, async () => {
    const session = await makeSession();
    const result = await create().install(session, [skill('alignment', '# A'), skill('iterative-review', '# I')]);
    expect(result.ok).toBe(true);

    const a = await readFile(at(session, skillsDir, 'alignment/SKILL.md'), 'utf-8');
    expect(a).toContain('name: alignment');
    expect(a).toContain('# A');
    expect(await readFile(at(session, skillsDir, 'iterative-review/SKILL.md'), 'utf-8')).toContain(
      'name: iterative-review'
    );
  });

  it('leaves a project-authored skill untouched (project wins)', async () => {
    const session = await makeSession();
    await mkdir(at(session, skillsDir, 'alignment'), { recursive: true });
    await writeFile(at(session, skillsDir, 'alignment/SKILL.md'), 'PROJECT VERSION', 'utf-8');

    expect((await create().install(session, [skill('alignment', '# bundled')])).ok).toBe(true);
    expect(await readFile(at(session, skillsDir, 'alignment/SKILL.md'), 'utf-8')).toBe('PROJECT VERSION');
  });

  it('uninstall removes only the skills install created', async () => {
    const session = await makeSession();
    await mkdir(at(session, skillsDir, 'abstraction-first'), { recursive: true });
    await writeFile(at(session, skillsDir, 'abstraction-first/SKILL.md'), 'PROJECT', 'utf-8');

    const adapter = create();
    await adapter.install(session, [skill('abstraction-first', 'bundled'), skill('alignment', '# A')]);
    expect((await adapter.uninstall(session)).ok).toBe(true);

    expect(await readFile(at(session, skillsDir, 'abstraction-first/SKILL.md'), 'utf-8')).toBe('PROJECT');
    expect(existsSync(at(session, skillsDir, 'alignment'))).toBe(false);
  });

  it('uninstall is a no-op when nothing was installed', async () => {
    expect((await create().uninstall(await makeSession())).ok).toBe(true);
  });

  it('a second install keeps the copy it already wrote', async () => {
    const session = await makeSession();
    const adapter = create();
    await adapter.install(session, [skill('alignment', '# v1')]);
    await adapter.install(session, [skill('alignment', '# v2 should not overwrite')]);
    expect(await readFile(at(session, skillsDir, 'alignment/SKILL.md'), 'utf-8')).toContain('# v1');
  });

  it(`uninstall tidies an emptied ${parentDir}, and keeps one with other content`, async () => {
    const emptied = await makeSession();
    const adapter = create();
    await adapter.install(emptied, [skill('alignment', '# A')]);
    await adapter.uninstall(emptied);
    expect(existsSync(at(emptied, parentDir))).toBe(false);

    const shared = await makeSession();
    await mkdir(at(shared, parentDir), { recursive: true });
    await writeFile(at(shared, parentDir, 'project-file.md'), '# project', 'utf-8');
    await adapter.install(shared, [skill('alignment', '# A')]);
    await adapter.uninstall(shared);
    expect(existsSync(at(shared, skillsDir))).toBe(false);
    expect(existsSync(at(shared, parentDir, 'project-file.md'))).toBe(true);
  });

  it(`describeSkillsConvention names ${skillsDir}/`, () => {
    expect(create().describeSkillsConvention()).toContain(`${skillsDir}/`);
  });

  it(`appends ${skillsDir}/ralphctl-* to .git/info/exclude once, across installs`, async () => {
    const session = await makeSession();
    await mkdir(at(session, '.git/info'), { recursive: true });
    await writeFile(at(session, '.git/info/exclude'), '# default\n', 'utf-8');

    const adapter = create();
    await adapter.install(session, [skill('ralphctl-alignment', '# A')]);
    await adapter.install(session, [skill('ralphctl-iterative-review', '# B')]);

    const lines = (await readFile(at(session, '.git/info/exclude'), 'utf-8')).split('\n');
    expect(lines.filter((l) => l.trim() === `${skillsDir}/ralphctl-*`)).toHaveLength(1);
  });

  it('installs into a non-git working tree', async () => {
    const session = await makeSession();
    expect((await create().install(session, [skill('ralphctl-alignment', '# A')])).ok).toBe(true);
    expect(await readFile(at(session, skillsDir, 'ralphctl-alignment/SKILL.md'), 'utf-8')).toContain('# A');
    expect(existsSync(at(session, '.git'))).toBe(false);
  });
});

it('has one row per provider in PROVIDER_TRAITS', () => {
  expect(new Set(ROWS.map((r) => r.provider))).toEqual(new Set(Object.keys(PROVIDER_TRAITS)));
});
