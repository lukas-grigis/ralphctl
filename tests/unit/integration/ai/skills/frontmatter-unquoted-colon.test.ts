import { describe, expect, it } from 'vitest';
import { parseYamlFrontmatter } from '@src/integration/ai/skills/_engine/frontmatter.ts';
import { parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';
import { parseAgentDefinition } from '@src/integration/ai/agents/_engine/parse-agent-definition.ts';

// Published skills and agents often carry `description: Use when: X` — invalid strict YAML, but
// accepted by the CLIs that load them. The reader must keep loading them, not drop them.

describe('unquoted ": " inside a top-level value', () => {
  it('parseYamlFrontmatter reads the whole value as the string', () => {
    const r = parseYamlFrontmatter('name: a\ndescription: Use when: reviewing code');
    expect(r.ok && r.value).toEqual({ name: 'a', description: 'Use when: reviewing code' });
  });

  it('keeps nested maps and other typed keys intact when one value needs the lenient read', () => {
    const r = parseYamlFrontmatter(
      'name: a\ndescription: Use when: x\nmetadata:\n  version: "1.0"\ndisable-model-invocation: true'
    );
    expect(r.ok && r.value).toEqual({
      name: 'a',
      description: 'Use when: x',
      metadata: { version: '1.0' },
      'disable-model-invocation': true,
    });
  });

  it('still rejects frontmatter that is broken for another reason', () => {
    expect(parseYamlFrontmatter('a: 1\na: 2').ok).toBe(false);
    expect(parseYamlFrontmatter('a: "unterminated').ok).toBe(false);
  });

  it('parseSkill loads a SKILL.md whose description has an unquoted colon', () => {
    const r = parseSkill(
      'operator skill',
      '/x/SKILL.md',
      'foo',
      '---\nname: foo\ndescription: Use when: X\n---\nbody\n'
    );
    expect(r.ok && r.value.description).toBe('Use when: X');
  });

  it('parseAgentDefinition loads an agent whose description has an unquoted colon', () => {
    const raw = '---\nname: hunter\ndescription: Use when: reviewing error handling\nmodel: inherit\n---\nbody\n';
    const r = parseAgentDefinition('operator agent', '/x/hunter.md', 'hunter', raw);
    expect(r.ok && r.value.description).toBe('Use when: reviewing error handling');
  });

  it('parseAgentDefinition names the YAML error instead of reporting missing fields', () => {
    const raw = '---\nname: hunter\nname: twice\ndescription: d\n---\nbody\n';
    const r = parseAgentDefinition('operator agent', '/x/hunter.md', 'hunter', raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/not valid YAML/u);
  });
});
