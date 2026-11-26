import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { splitFrontmatter } from '@src/integration/ai/skills/_engine/frontmatter.ts';
import { parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';

// A string field that looks like a number / boolean / null must render quoted, or a downstream
// YAML reader (and ralphctl's own z.string() schema) reads it back as a different type.

describe('renderSkill — typed-looking string fields stay strings', () => {
  it.each([
    ['license', '1.0'],
    ['description', 'true'],
    ['description', 'null'],
    ['compatibility', '2024'],
    ['allowed-tools', 'yes'],
  ])('%s: %s round-trips as the same string', async (field, value) => {
    const session = await mkdtemp(join(tmpdir(), 'typed-scalars-'));
    const parsedSession = AbsolutePath.parse(session);
    if (!parsedSession.ok) throw new Error(parsedSession.error.message);
    const skill = {
      name: 'ralphctl-typed',
      description: field === 'description' ? value : 'a description',
      ...(field === 'license' ? { license: value } : {}),
      ...(field === 'compatibility' ? { compatibility: value } : {}),
      ...(field === 'allowed-tools' ? { allowedTools: value } : {}),
      content: '# body',
    };
    const installed = await createCopilotSkillsAdapter().install(parsedSession.value, [skill]);
    expect(installed.ok).toBe(true);

    const raw = await readFile(join(session, '.github/skills/ralphctl-typed/SKILL.md'), 'utf-8');
    const map = parse(splitFrontmatter(raw).frontmatter) as Record<string, unknown>;
    expect(map[field]).toBe(value);
    expect(parseSkill('installed skill', 'x', 'ralphctl-typed', raw).ok).toBe(true);
  });
});
