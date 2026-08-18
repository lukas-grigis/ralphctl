import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { parseSimpleYaml, splitFrontmatter } from '@src/integration/ai/skills/_engine/frontmatter.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';

/**
 * Installed SKILL.md frontmatter is read back by the downstream CLIs' STRICT YAML parsers —
 * Copilot rejects an unquoted plain scalar containing `: ` with "mapping values are not allowed
 * in this context" and refuses to load the skill. ralphctl's own reader is deliberately naive
 * and tolerated such values, which is exactly how one shipped: this suite pins the contract
 * from the strict consumer's side, for both the render path (adapter install) and the bundled
 * sources that are copied verbatim.
 */

/**
 * The strict-YAML rules a flat `key: value` frontmatter line must satisfy for the downstream
 * parsers: a value is either quoted, or a plain scalar that contains no `: ` / ` #`, does not
 * start with an indicator character, and does not end with `:` or whitespace.
 */
const isStrictSafeLine = (line: string): boolean => {
  const match = /^(?<key>[a-z][a-z-]*): (?<value>.*)$/u.exec(line);
  if (!match?.groups) return false;
  const value = match.groups['value'] ?? '';
  if (/^"(?:[^"\\]|\\.)*"$/u.test(value)) return true;
  if (/^'[^']*'$/u.test(value)) return true;
  return /^[A-Za-z0-9]/u.test(value) && !value.includes(': ') && !value.includes(' #') && !/[\s:]$/u.test(value);
};

const makeSession = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'strict-yaml-skills-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const install = async (skill: Skill): Promise<string> => {
  const session = await makeSession();
  const adapter = createCopilotSkillsAdapter();
  const result = await adapter.install(session, [skill]);
  expect(result.ok).toBe(true);
  return readFile(join(String(session), '.github/skills', skill.name, 'SKILL.md'), 'utf-8');
};

describe('renderSkill — strict-YAML-safe frontmatter for downstream parsers', () => {
  it('quotes a description containing ": " (the exact shape Copilot rejected unquoted)', async () => {
    const description =
      'Cross-phase skill — do the thing before producing output: restate, surface assumptions, agree.';
    const raw = await install({ name: 'ralphctl-colon-desc', description, content: '# body' });

    const { frontmatter } = splitFrontmatter(raw);
    for (const line of frontmatter.split('\n'))
      expect(line, `unsafe frontmatter line: ${line}`).toSatisfy(isStrictSafeLine);
    // Round-trip: ralphctl's own reader recovers the original description from the quoted form.
    expect(parseSimpleYaml(frontmatter)['description']).toBe(description);
  });

  it('escapes embedded double quotes and backslashes, and round-trips them', async () => {
    const description = 'Use "quoted" phrases: even with a back\\slash.';
    const raw = await install({ name: 'ralphctl-quote-desc', description, content: '# body' });

    const { frontmatter } = splitFrontmatter(raw);
    for (const line of frontmatter.split('\n'))
      expect(line, `unsafe frontmatter line: ${line}`).toSatisfy(isStrictSafeLine);
    expect(parseSimpleYaml(frontmatter)['description']).toBe(description);
  });

  it('leaves a safe plain-scalar description unquoted (files stay human-readable)', async () => {
    const description = 'Plain description — em-dashes, commas, and even mid:colons are fine unquoted.';
    const raw = await install({ name: 'ralphctl-plain-desc', description, content: '# body' });

    expect(raw).toContain(`description: ${description}`);
  });

  it('quotes the optional license / compatibility / allowed-tools values when unsafe', async () => {
    const raw = await install({
      name: 'ralphctl-optional-keys',
      description: 'safe',
      content: '# body',
      license: 'MIT: see LICENSE',
      compatibility: 'claude, copilot',
      allowedTools: 'Read, Grep: no writes',
    });

    const { frontmatter } = splitFrontmatter(raw);
    for (const line of frontmatter.split('\n'))
      expect(line, `unsafe frontmatter line: ${line}`).toSatisfy(isStrictSafeLine);
    const parsed = parseSimpleYaml(frontmatter);
    expect(parsed['license']).toBe('MIT: see LICENSE');
    expect(parsed['allowed-tools']).toBe('Read, Grep: no writes');
  });
});

describe('bundled skill sources — frontmatter parses under strict YAML', () => {
  it('every src/integration/ai/skills/bundled/*/SKILL.md is strict-safe as authored', async () => {
    // The catalog enable path copies these files VERBATIM (no re-render), so the sources
    // themselves must already satisfy the strict consumers — quoting in the renderer alone
    // does not cover them.
    const bundledDir = join(process.cwd(), 'src/integration/ai/skills/bundled');
    const entries = await readdir(bundledDir, { withFileTypes: true });
    const skillDirs = entries.filter((entry) => entry.isDirectory());
    expect(skillDirs.length).toBeGreaterThan(0);

    for (const dir of skillDirs) {
      const raw = await readFile(join(bundledDir, dir.name, 'SKILL.md'), 'utf-8');
      const { frontmatter } = splitFrontmatter(raw);
      expect(frontmatter, `${dir.name}/SKILL.md has no frontmatter`).not.toBe('');
      for (const line of frontmatter.split('\n'))
        expect(line, `${dir.name}/SKILL.md unsafe frontmatter line: ${line}`).toSatisfy(isStrictSafeLine);
    }
  });
});
