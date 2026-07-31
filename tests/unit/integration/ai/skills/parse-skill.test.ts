import { describe, expect, it } from 'vitest';
import { parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';

// splitFrontmatter / parseSimpleYaml / errorCode moved to the shared
// tests/unit/integration/ai/skills/frontmatter.test.ts suite — this file now tests parseSkill's
// own validation behavior on top of that shared parsing.

describe('parseSkill', () => {
  it('parses a valid skill round-trip', () => {
    const raw = '---\nname: alignment\ndescription: Confirm scope before diving into work.\n---\nBody text.\n';
    const result = parseSkill('bundled skill', '/path/alignment/SKILL.md', 'alignment', raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        name: 'alignment',
        description: 'Confirm scope before diving into work.',
        content: 'Body text.\n',
      });
    }
  });

  it('returns a parse StorageError when the description is missing', () => {
    const raw = '---\nname: alignment\n---\nBody text.\n';
    const result = parseSkill('bundled skill', '/path/alignment/SKILL.md', 'alignment', raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('parse');
    }
  });

  it('returns a parse StorageError when the frontmatter name does not match the folder name', () => {
    const raw = '---\nname: other\ndescription: Some description.\n---\nBody text.\n';
    const result = parseSkill('bundled skill', '/path/alignment/SKILL.md', 'alignment', raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('parse');
    }
  });
});
