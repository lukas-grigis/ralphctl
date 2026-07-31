import { describe, expect, it } from 'vitest';
import { parseAgentDefinition } from '@src/integration/ai/agents/_engine/parse-agent-definition.ts';

// splitFrontmatter / parseSimpleYaml / errorCode moved to the shared
// tests/unit/integration/ai/skills/frontmatter.test.ts suite — this file now tests
// parseAgentDefinition's own validation behavior on top of that shared parsing.

describe('parseAgentDefinition', () => {
  it('parses a valid agent definition round-trip', () => {
    const raw =
      '---\nname: implementer\ndescription: Writes features, fixes bugs, adds tests.\nmodel: claude-sonnet-5\neffort: high\n---\nYou are an implementer.\n';
    const result = parseAgentDefinition('bundled agent', '/path/implementer.md', 'implementer', raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        name: 'implementer',
        description: 'Writes features, fixes bugs, adds tests.',
        model: 'claude-sonnet-5',
        effort: 'high',
        content: 'You are an implementer.\n',
      });
    }
  });

  it('returns a parse StorageError when the description is missing', () => {
    const raw = '---\nname: implementer\n---\nYou are an implementer.\n';
    const result = parseAgentDefinition('bundled agent', '/path/implementer.md', 'implementer', raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('parse');
    }
  });

  it('returns a parse StorageError when the frontmatter name does not match the source name', () => {
    const raw = '---\nname: other\ndescription: Writes features.\n---\nYou are an implementer.\n';
    const result = parseAgentDefinition('bundled agent', '/path/implementer.md', 'implementer', raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.subCode).toBe('parse');
    }
  });
});
