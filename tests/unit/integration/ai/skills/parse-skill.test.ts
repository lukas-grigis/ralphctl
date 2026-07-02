import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from '@src/integration/ai/skills/_engine/parse-skill.ts';

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
});
