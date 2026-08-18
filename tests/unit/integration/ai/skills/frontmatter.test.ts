import { describe, expect, it } from 'vitest';
import { errorCode, parseSimpleYaml, splitFrontmatter } from '@src/integration/ai/skills/_engine/frontmatter.ts';

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

describe('parseSimpleYaml', () => {
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

  it('skips lines with no colon', () => {
    expect(parseSimpleYaml('not a kv line\na: 1')).toEqual({ a: '1' });
  });

  it('unescapes \\" and \\\\ inside a double-quoted value (the renderer emits this shape)', () => {
    expect(parseSimpleYaml('a: "say \\"hi\\": a back\\\\slash"')).toEqual({ a: 'say "hi": a back\\slash' });
  });

  it('leaves single-quoted values verbatim — no escape handling', () => {
    expect(parseSimpleYaml("a: 'no \\\" unescaping here'")).toEqual({ a: 'no \\" unescaping here' });
  });

  it('treats a lone quote character as a plain value, not an empty quoted string', () => {
    expect(parseSimpleYaml('a: "\nb: \'')).toEqual({ a: '"', b: "'" });
  });
});

describe('errorCode', () => {
  it('reads the code off a Node-style fs error', () => {
    expect(errorCode({ code: 'ENOENT' })).toBe('ENOENT');
  });

  it('returns undefined for a value with no string code property', () => {
    expect(errorCode(new Error('boom'))).toBeUndefined();
    expect(errorCode('not an object')).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode({ code: 42 })).toBeUndefined();
  });
});
