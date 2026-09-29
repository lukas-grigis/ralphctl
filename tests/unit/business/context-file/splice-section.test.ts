import { describe, expect, it } from 'vitest';
import type { Result } from '@src/domain/result.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { appendSections, spliceOwnedSection } from '@src/business/context-file/splice-section.ts';

const H = 'Learnings (AI sessions)';
const ok = (r: Result<string, ValidationError>): string => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return r.value;
};

describe('spliceOwnedSection', () => {
  it('replaces an existing section and preserves everything else byte-for-byte', () => {
    const existing = `# Title\n\nintro  \n\n## ${H}\n\n- old\n\n## Other\n\nkeep\tme  \n`;
    const out = ok(spliceOwnedSection(existing, H, '- new one\n- new two'));
    expect(out).toBe(`# Title\n\nintro  \n\n## ${H}\n\n- new one\n- new two\n\n## Other\n\nkeep\tme  \n`);
  });

  it('is idempotent', () => {
    const existing = `# T\n\n## ${H}\n\n- a\n\n## Z\n\nz\n`;
    const once = ok(spliceOwnedSection(existing, H, '- b'));
    expect(ok(spliceOwnedSection(once, H, '- b'))).toBe(once);
  });

  it('appends after the last section with one blank line when absent', () => {
    expect(ok(spliceOwnedSection('# T\n\ntext\n', H, '- a'))).toBe(`# T\n\ntext\n\n## ${H}\n\n- a\n`);
  });

  it('adds the missing final newline and blank line before appending', () => {
    expect(ok(spliceOwnedSection('# T\ntext', H, '- a'))).toBe(`# T\ntext\n\n## ${H}\n\n- a\n`);
  });

  it('creates the file content from an empty or whitespace-only file', () => {
    expect(ok(spliceOwnedSection('', H, '- a'))).toBe(`## ${H}\n\n- a\n`);
    expect(ok(spliceOwnedSection('  \n\n', H, '- a'))).toBe(`## ${H}\n\n- a\n`);
  });

  it('replaces a section at EOF and keeps a missing trailing newline missing', () => {
    expect(ok(spliceOwnedSection(`# T\n\n## ${H}\n\n- old`, H, '- new'))).toBe(`# T\n\n## ${H}\n\n- new`);
  });

  it('replaces a section at EOF and keeps the trailing newline', () => {
    expect(ok(spliceOwnedSection(`# T\n\n## ${H}\n\n- old\n`, H, '- new'))).toBe(`# T\n\n## ${H}\n\n- new\n`);
  });

  it('matches heading variants: case, extra spaces, closing hashes, trailing whitespace', () => {
    for (const variant of [`##   ${H.toUpperCase()}`, `## ${H} ##`, `## ${H}   `]) {
      const out = ok(spliceOwnedSection(`# T\n\n${variant}\n\n- old\n\n## Z\n\nz\n`, H, '- new'));
      expect(out).toContain('- new');
      expect(out).not.toContain('- old');
      expect(out).toContain('## Z\n\nz\n');
    }
  });

  it('does not treat H3 or a longer title as the owned heading', () => {
    const existing = `# T\n\n### ${H}\n\n- h3\n\n## ${H} extras\n\n- x\n`;
    const out = ok(spliceOwnedSection(existing, H, '- a'));
    expect(out.startsWith(existing)).toBe(true);
    expect(out.endsWith(`\n\n## ${H}\n\n- a\n`)).toBe(true);
  });

  it('keeps nested H3 subsections inside the replaced section boundary', () => {
    const out = ok(spliceOwnedSection(`## ${H}\n\n### sub\n\n- old\n\n## Z\n\nz\n`, H, '- new'));
    expect(out).toBe(`## ${H}\n\n- new\n\n## Z\n\nz\n`);
  });

  it('ignores headings inside fenced code blocks', () => {
    const existing = `# T\n\n\`\`\`md\n## ${H}\n- fake\n\`\`\`\n\n## ${H}\n\n- real\n`;
    const out = ok(spliceOwnedSection(existing, H, '- new'));
    expect(out).toBe(`# T\n\n\`\`\`md\n## ${H}\n- fake\n\`\`\`\n\n## ${H}\n\n- new\n`);
  });

  it('a fenced H2 inside the section does not end the section', () => {
    const existing = `## ${H}\n\n\`\`\`\n## not a heading\n\`\`\`\n\n## Z\n\nz\n`;
    expect(ok(spliceOwnedSection(existing, H, '- new'))).toBe(`## ${H}\n\n- new\n\n## Z\n\nz\n`);
  });

  it('preserves CRLF files and normalises the model delta to CRLF', () => {
    const existing = `# T\r\n\r\ntext\r\n\r\n## ${H}\r\n\r\n- old\r\n\r\n## Z\r\n\r\nz\r\n`;
    const out = ok(spliceOwnedSection(existing, H, '- a\n- b'));
    expect(out).toBe(`# T\r\n\r\ntext\r\n\r\n## ${H}\r\n\r\n- a\r\n- b\r\n\r\n## Z\r\n\r\nz\r\n`);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('appends with CRLF when the file is CRLF', () => {
    expect(ok(spliceOwnedSection('# T\r\n', H, '- a'))).toBe(`# T\r\n\r\n## ${H}\r\n\r\n- a\r\n`);
  });

  it('tolerates the model echoing the owned heading', () => {
    expect(ok(spliceOwnedSection('', H, `## ${H}\n\n- a`))).toBe(`## ${H}\n\n- a\n`);
  });

  it('fails safe on duplicate owned headings', () => {
    const r = spliceOwnedSection(`## ${H}\n\n- a\n\n## Z\n\nz\n\n## ${H}\n\n- b\n`, H, '- c');
    expect(r.ok).toBe(false);
  });

  it('fails safe on an empty body', () => {
    expect(spliceOwnedSection('# T\n', H, '  \n\n').ok).toBe(false);
    expect(spliceOwnedSection('# T\n', H, `## ${H}\n`).ok).toBe(false);
  });

  it('fails safe when the body carries its own H1/H2 heading', () => {
    expect(spliceOwnedSection('# T\n', H, '- a\n\n## Sneaky\n\n- b').ok).toBe(false);
    expect(spliceOwnedSection('# T\n', H, '# Whole file\n\n- b').ok).toBe(false);
  });

  it('allows H3 and fenced hashes inside the body', () => {
    const out = ok(spliceOwnedSection('', H, '### sub\n\n```sh\n## comment\n```'));
    expect(out).toContain('### sub');
  });
});

describe('appendSections', () => {
  it('appends after the existing body, preserving it byte-for-byte as a prefix', () => {
    const existing = '# T\n\nhand  written\t\n';
    const out = ok(appendSections(existing, '## Testing\n\n- run x\n'));
    expect(out).toBe(`${existing}\n## Testing\n\n- run x\n`);
    expect(out.startsWith(existing)).toBe(true);
  });

  it('adds a missing trailing newline and blank line', () => {
    expect(ok(appendSections('# T', '## A\n\nx'))).toBe('# T\n\n## A\n\nx\n');
  });

  it('uses the whole proposal for an empty existing file', () => {
    expect(ok(appendSections('', '# T\n\n## A\n\nx\n'))).toBe('# T\n\n## A\n\nx\n\n'.trimEnd() + '\n');
  });

  it('preserves CRLF', () => {
    expect(ok(appendSections('# T\r\n', '## A\n\nx'))).toBe('# T\r\n\r\n## A\r\n\r\nx\r\n');
  });

  it('does not duplicate the body when the model returned the full file anyway', () => {
    const existing = '# T\n\ntext\n';
    const full = '# T\n\ntext\n\n## New\n\nx\n';
    expect(ok(appendSections(existing, full))).toBe(full);
  });

  it('leaves a non-empty file unchanged when there is nothing to add', () => {
    expect(ok(appendSections('# T\r\n', ' \n'))).toBe('# T\r\n');
  });

  it('fails safe when both the file and the additions are empty', () => {
    expect(appendSections('', ' \n').ok).toBe(false);
  });
});
