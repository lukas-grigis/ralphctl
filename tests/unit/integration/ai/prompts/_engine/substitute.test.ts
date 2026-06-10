import { describe, expect, it } from 'vitest';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { assertTemplateKeysFilled, substitute } from '@src/integration/ai/prompts/_engine/substitute.ts';

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
