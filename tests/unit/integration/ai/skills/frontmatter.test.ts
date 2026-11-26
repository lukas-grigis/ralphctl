import { describe, expect, it } from 'vitest';
import {
  flattenFrontmatter,
  parseYamlFrontmatter,
  splitFrontmatter,
} from '@src/integration/ai/skills/_engine/frontmatter.ts';

// Canonical frontmatter-parsing suite — the single implementation both SKILL.md sources
// (skills/_engine/parse-skill.ts) and agent-definition sources (agents/_engine/parse-agent-
// definition.ts) build on. Consolidates what used to be two byte-identical, independently
// maintained partial suites (one per concept) so a regression in either concept's behaviour is
// caught here once instead of drifting silently.

describe('splitFrontmatter', () => {
  it('splits frontmatter from a body that follows immediately after the closing fence', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n---\nbody line\n');
    expect(frontmatter).toBe('name: x');
    expect(body).toBe('body line\n');
  });

  it('strips the blank separator line after the closing fence (standard SKILL.md shape)', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n---\n\nbody line\n');
    expect(frontmatter).toBe('name: x');
    expect(body).toBe('body line\n');
  });

  it('strips CRLF blank lines after the closing fence', () => {
    const { body } = splitFrontmatter('---\r\nname: x\r\n---\r\n\r\nbody line\r\n');
    expect(body).toBe('body line\r\n');
  });

  it('strips a leading UTF-8 BOM before detecting the opening fence', () => {
    const { frontmatter, body } = splitFrontmatter('﻿---\nname: x\n---\nbody line\n');
    expect(frontmatter).toBe('name: x');
    expect(body).toBe('body line\n');
  });

  it('does not accumulate blank lines across parse → render round-trips', () => {
    // Mirror the render shape from filesystem-skills-adapter: fence + ONE blank separator + body.
    const render = (frontmatter: string, content: string): string =>
      `---\n${frontmatter}\n---\n\n${content.replace(/\s+$/u, '')}\n`;

    const once = splitFrontmatter(render('name: x', 'body line'));
    const twice = splitFrontmatter(render(once.frontmatter, once.body));
    expect(twice.body).toBe(once.body);
    expect(twice.body.startsWith('\n')).toBe(false);
  });

  it('returns the body verbatim when no frontmatter is present', () => {
    const { frontmatter, body } = splitFrontmatter('just a body\n');
    expect(frontmatter).toBe('');
    expect(body).toBe('just a body\n');
  });

  it('returns the body verbatim when the opening fence has no closing fence', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\nno closing fence\n');
    expect(frontmatter).toBe('');
    expect(body).toBe('---\nname: x\nno closing fence\n');
  });
});

const parseSimpleYaml = (input: string): Record<string, string> => {
  const parsed = parseYamlFrontmatter(input);
  return parsed.ok ? flattenFrontmatter(parsed.value) : {};
};

describe('flattenFrontmatter over parseYamlFrontmatter', () => {
  it('parses flat key: value lines', () => {
    expect(parseSimpleYaml('name: x\ndescription: does a thing')).toEqual({
      name: 'x',
      description: 'does a thing',
    });
  });

  it('strips matching double or single quotes around a value', () => {
    expect(parseSimpleYaml('a: "quoted"\nb: \'single\'')).toEqual({ a: 'quoted', b: 'single' });
  });

  it('skips blank lines and comment lines', () => {
    expect(parseSimpleYaml('a: 1\n\n# a comment\nb: 2')).toEqual({ a: '1', b: '2' });
  });

  it('rejects a stray non key: value line instead of silently skipping it', () => {
    expect(parseSimpleYaml('not a kv line\na: 1')).toEqual({});
  });

  it('unescapes \\" and \\\\ inside a double-quoted value (the renderer emits this shape)', () => {
    expect(parseSimpleYaml('a: "say \\"hi\\": a back\\\\slash"')).toEqual({ a: 'say "hi": a back\\slash' });
  });

  it('leaves single-quoted values verbatim — no escape handling', () => {
    expect(parseSimpleYaml("a: 'no \\\" unescaping here'")).toEqual({ a: 'no \\" unescaping here' });
  });

  it('projects only top-level scalars to strings — a nested map never clobbers a top-level key', () => {
    expect(parseSimpleYaml('name: real\nmetadata:\n  name: nested\neffort: 3')).toEqual({ name: 'real', effort: '3' });
  });

  it('reads a folded scalar as its text, not the `>` indicator', () => {
    expect(parseSimpleYaml('description: >\n  folded\n  text')).toEqual({ description: 'folded text' });
  });

  it('yields an empty map for frontmatter that is not valid YAML', () => {
    expect(parseSimpleYaml('a: "\nb: \'')).toEqual({});
  });
});

describe('parseYamlFrontmatter', () => {
  it('parses a folded scalar (`>`) into its folded text', () => {
    const r = parseYamlFrontmatter('name: x\ndescription: >\n  first line\n  second line\n');
    expect(r.ok && r.value['description']).toBe('first line second line\n');
  });

  it('parses a literal scalar (`|`) keeping its line breaks', () => {
    const r = parseYamlFrontmatter('description: |\n  one\n  two\n');
    expect(r.ok && r.value['description']).toBe('one\ntwo\n');
  });

  it('keeps a nested metadata map nested — its keys never overwrite top-level keys', () => {
    const r = parseYamlFrontmatter('name: real\nmetadata:\n  name: nested\n  version: "1.0"\n');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value['name']).toBe('real');
      expect(r.value['metadata']).toEqual({ name: 'nested', version: '1.0' });
    }
  });

  it('keeps non-string scalars typed (booleans stay booleans)', () => {
    const r = parseYamlFrontmatter('disable-model-invocation: true');
    expect(r.ok && r.value['disable-model-invocation']).toBe(true);
  });

  it('returns an empty map for empty frontmatter', () => {
    const r = parseYamlFrontmatter('');
    expect(r.ok && r.value).toEqual({});
  });

  it('rejects malformed YAML, duplicate keys and a non-map document', () => {
    expect(parseYamlFrontmatter('a: "unterminated').ok).toBe(false);
    expect(parseYamlFrontmatter('a: 1\na: 2').ok).toBe(false);
    expect(parseYamlFrontmatter('- just\n- a list').ok).toBe(false);
  });
});
