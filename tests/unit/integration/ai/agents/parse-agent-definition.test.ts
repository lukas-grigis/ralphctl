import { describe, expect, it } from 'vitest';
import { parseAgentDefinition, splitFrontmatter } from '@src/integration/ai/agents/_engine/parse-agent-definition.ts';

describe('splitFrontmatter', () => {
  it('splits frontmatter from a body that follows immediately after the closing fence', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n---\nbody line\n');
    expect(frontmatter).toBe('name: x');
    expect(body).toBe('body line\n');
  });

  it('strips the blank separator line after the closing fence', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n---\n\nbody line\n');
    expect(frontmatter).toBe('name: x');
    expect(body).toBe('body line\n');
  });

  it('returns the body verbatim when no frontmatter is present', () => {
    const { frontmatter, body } = splitFrontmatter('just a body\n');
    expect(frontmatter).toBe('');
    expect(body).toBe('just a body\n');
  });
});

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
