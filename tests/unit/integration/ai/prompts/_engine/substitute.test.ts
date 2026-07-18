import { describe, expect, it } from 'vitest';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { assertTemplateKeysFilled, substitute } from '@src/integration/ai/prompts/_engine/substitute.ts';
import { PRECAPPED_SECTION_CHAR_CAP, SECTION_CHAR_CAP } from '@src/integration/ai/prompts/_engine/compress-section.ts';

describe('substitute', () => {
  it('replaces a single placeholder with the matching value', () => {
    expect(substitute('Hello {{NAME}}', { NAME: 'Ada' })).toBe('Hello Ada');
  });

  it('replaces every occurrence of the same placeholder', () => {
    expect(substitute('{{X}} and {{X}} again', { X: 'one' })).toBe('one and one again');
  });

  it('replaces multiple distinct placeholders', () => {
    expect(substitute('{{A}}/{{B}}', { A: 'left', B: 'right' })).toBe('left/right');
  });

  it('leaves unknown placeholders intact (fail-soft)', () => {
    expect(substitute('Hi {{NAME}}, code {{MISSING}}', { NAME: 'Ada' })).toBe('Hi Ada, code {{MISSING}}');
  });

  it('treats an empty-string value as opt-out — replaces with empty', () => {
    expect(substitute('before{{SLOT}}after', { SLOT: '' })).toBe('beforeafter');
  });

  it('does not interpret regex specials in the replacement value', () => {
    expect(substitute('x={{V}}', { V: '$&$1$<X>' })).toBe('x=$&$1$<X>');
  });

  it('rejects malformed placeholders (lowercase, leading digit)', () => {
    expect(substitute('{{lower}}', { lower: 'no' })).toBe('{{lower}}');
    expect(substitute('{{1BAD}}', { '1BAD': 'no' })).toBe('{{1BAD}}');
  });

  it('treats explicit-undefined values the same as absent', () => {
    const values: Record<string, string | undefined> = { K: undefined };
    expect(substitute('{{K}}', values as Record<string, string>)).toBe('{{K}}');
  });
});

describe('assertTemplateKeysFilled — template-side fence', () => {
  it('brands the rendered string as Prompt when every template key has a value', () => {
    const template = 'Hello {{NAME}}';
    const values = { NAME: 'Ada' };
    const result = assertTemplateKeysFilled(substitute(template, values), template, [], values, 'test-builder');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('Hello Ada');
  });

  it('returns ParseError listing each UNFILLED template key, deduped, in first-seen order', () => {
    const template = 'a {{X}} b {{Y}} c {{X}}';
    const result = assertTemplateKeysFilled(template, template, [], {}, 'test-builder');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ParseError);
      expect(result.error.subCode).toBe('schema-mismatch');
      expect(result.error.message).toContain('{{X}}');
      expect(result.error.message).toContain('{{Y}}');
      expect(result.error.message).toContain('test-builder');
      // Deduped: only one mention of each unique placeholder.
      const xCount = (result.error.message.match(/\{\{X\}\}/g) ?? []).length;
      expect(xCount).toBe(1);
    }
  });

  it('a placeholder-shaped literal inside a SUBSTITUTED VALUE is legal — AI prose is not template drift', () => {
    // The poison scenario: an AI-journaled change like 'added {{ROUND_NUMBER}} to the template'
    // is substituted into {{PRIOR_PROGRESS}}. The old post-render scan rejected the rendered
    // prompt forever (the depth-preserving cap re-inlined the same journal on every retry);
    // the template-side fence accepts it as inert prose.
    const template = 'Journal:\n{{PRIOR_PROGRESS}}';
    const values = { PRIOR_PROGRESS: 'Decision: added {{ROUND_NUMBER}} to the template per CLAUDE.md rules' };
    const rendered = substitute(template, values);
    const result = assertTemplateKeysFilled(rendered, template, [], values, 'test-builder');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('{{ROUND_NUMBER}}'); // delivered verbatim, inert
  });

  it('counts placeholders declared inside PARTIAL bodies as template-declared (drift fence preserved)', () => {
    // A partial whose body carries an unfilled key must still fail — in-partial drift is real
    // drift; only VALUE-side placeholder text is exempt.
    const template = 'Top: {{HARNESS_CONTEXT}}';
    const partialBody = 'partial needs {{VERIFY_SCRIPT}}';
    const values = { HARNESS_CONTEXT: partialBody };
    const rendered = substitute(template, values);
    const result = assertTemplateKeysFilled(rendered, template, [partialBody], values, 'test-builder');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('{{VERIFY_SCRIPT}}');
  });
});

describe('COMPRESSIBLE_KEYS — two-tier compression (regression)', () => {
  /**
   * Builds a `capProgressBody`-shaped value: a header band, a full current-task attempt section,
   * and several sibling sections — well over the old 4,000-char `SECTION_CHAR_CAP` but nowhere near
   * `PRECAPPED_SECTION_CHAR_CAP`. Doesn't need to come from the real `capProgressBody` — the bug is
   * that ANY pre-capped value over 4K chars got blindly re-truncated regardless of its producer.
   */
  const buildPreCappedProgressBody = (): string => {
    const header = '# Sprint: demo\n\n- id: s-1\n- created: 2026-06-09T00:00:00.000Z\n\n';
    const currentTaskSection =
      `## Task: implement-thing — Attempt 3 · id:task-current\n\n` +
      `_2026-06-09T00:00:00.000Z_\n\n${'earlier attempt warnings and remedies. '.repeat(150)}\n`;
    const siblingSection = (name: string): string =>
      `## Task: ${name} — Attempt 1 · id:task-${name}\n\n_2026-06-09T00:00:00.000Z_\n\n${'sibling work. '.repeat(50)}\n`;
    return header + currentTaskSection + siblingSection('a') + siblingSection('b') + siblingSection('c');
  };

  it('PRIOR_PROGRESS over the old 4K cap but under PRECAPPED_SECTION_CHAR_CAP rides byte-for-byte (head retained, no truncation notice)', () => {
    const body = buildPreCappedProgressBody();
    expect(body.length).toBeGreaterThan(SECTION_CHAR_CAP);
    expect(body.length).toBeLessThan(PRECAPPED_SECTION_CHAR_CAP);

    const rendered = substitute('Journal:\n{{PRIOR_PROGRESS}}', { PRIOR_PROGRESS: body });

    expect(rendered).toBe(`Journal:\n${body}`);
    expect(rendered).not.toContain('earlier content omitted');
    // The head — sprint header + the current task's own history — survives verbatim.
    expect(rendered).toContain('# Sprint: demo');
    expect(rendered).toContain('## Task: implement-thing — Attempt 3 · id:task-current');
  });

  it('PRIOR_LEARNINGS over the old 4K cap but under PRECAPPED_SECTION_CHAR_CAP rides byte-for-byte', () => {
    const body = `- ${'a learning. '.repeat(400)}`;
    expect(body.length).toBeGreaterThan(SECTION_CHAR_CAP);
    expect(body.length).toBeLessThan(PRECAPPED_SECTION_CHAR_CAP);

    const rendered = substitute('Learnings:\n{{PRIOR_LEARNINGS}}', { PRIOR_LEARNINGS: body });

    expect(rendered).toBe(`Learnings:\n${body}`);
    expect(rendered).not.toContain('earlier content omitted');
  });

  it('a PRIOR_PROGRESS value that genuinely overflows PRECAPPED_SECTION_CHAR_CAP still gets tail-compressed with the notice', () => {
    const body = 'x'.repeat(PRECAPPED_SECTION_CHAR_CAP + 500);
    const rendered = substitute('Journal:\n{{PRIOR_PROGRESS}}', { PRIOR_PROGRESS: body });

    expect(rendered).toContain('earlier content omitted');
    const tail = body.slice(-PRECAPPED_SECTION_CHAR_CAP);
    expect(rendered.endsWith(tail)).toBe(true);
  });
});
