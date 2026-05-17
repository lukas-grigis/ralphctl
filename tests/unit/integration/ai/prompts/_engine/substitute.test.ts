import { describe, expect, it } from 'vitest';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { assertFullySubstituted, substitute } from '@src/integration/ai/prompts/_engine/substitute.ts';

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

describe('assertFullySubstituted', () => {
  it('returns the input branded as Prompt when no placeholders remain', () => {
    const result = assertFullySubstituted('clean text', 'test-builder');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('clean text');
  });

  it('returns ParseError listing each leftover placeholder, deduped, in first-seen order', () => {
    const result = assertFullySubstituted('a {{X}} b {{Y}} c {{X}}', 'test-builder');
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
});
