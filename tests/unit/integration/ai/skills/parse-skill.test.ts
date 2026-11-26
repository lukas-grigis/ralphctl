import { describe, expect, it } from 'vitest';
import { parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';

// splitFrontmatter / parseYamlFrontmatter are covered by the shared
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

  it('reads a folded-scalar description as its text (never the `>` indicator)', () => {
    const raw = '---\nname: alignment\ndescription: >\n  Confirm scope\n  before work.\n---\nBody.\n';
    const result = parseSkill('operator skill', '/p/alignment/SKILL.md', 'alignment', raw);
    expect(result.ok && result.value.description).toBe('Confirm scope before work.');
  });

  it('a nested metadata.name neither overwrites nor fails the real name, and metadata passes through', () => {
    const raw = '---\nname: alignment\ndescription: d\nmetadata:\n  name: other\n  author: acme\n---\nBody.\n';
    const result = parseSkill('operator skill', '/p/alignment/SKILL.md', 'alignment', raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('alignment');
      expect(result.value.extraFrontmatter).toEqual({ metadata: { name: 'other', author: 'acme' } });
    }
  });

  it('passes provider-specific keys such as disable-model-invocation through typed', () => {
    const raw = '---\nname: alignment\ndescription: d\ndisable-model-invocation: true\n---\nBody.\n';
    const result = parseSkill('operator skill', '/p/alignment/SKILL.md', 'alignment', raw);
    expect(result.ok && result.value.extraFrontmatter).toEqual({ 'disable-model-invocation': true });
  });

  it('rejects a whitespace-only description and invalid YAML with a parse error', () => {
    const blank = parseSkill('s', '/p/a/SKILL.md', 'a', '---\nname: a\ndescription: "  "\n---\nB\n');
    expect(!blank.ok && blank.error.subCode).toBe('parse');
    const broken = parseSkill('s', '/p/a/SKILL.md', 'a', '---\nname: a\ndescription: "open\n---\nB\n');
    expect(!broken.ok && broken.error.subCode).toBe('parse');
  });
});
