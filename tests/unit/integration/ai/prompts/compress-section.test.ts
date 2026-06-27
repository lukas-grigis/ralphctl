import { describe, expect, it } from 'vitest';
import { compressSection, SECTION_CHAR_CAP } from '@src/integration/ai/prompts/_engine/compress-section.ts';

describe('compressSection', () => {
  it('returns content unchanged when at or below the default cap', () => {
    const short = 'a'.repeat(SECTION_CHAR_CAP);
    expect(compressSection(short)).toBe(short);
  });

  it('returns content unchanged when strictly below the default cap', () => {
    const short = 'hello world';
    expect(compressSection(short)).toBe(short);
  });

  it('returns empty string unchanged', () => {
    expect(compressSection('')).toBe('');
  });

  it('tail-trims content above the default cap to exactly cap characters (plus notice)', () => {
    const content = 'x'.repeat(SECTION_CHAR_CAP + 500);
    const result = compressSection(content);
    // The retained tail must be exactly the last SECTION_CHAR_CAP characters.
    const tail = content.slice(-SECTION_CHAR_CAP);
    expect(result.endsWith(tail)).toBe(true);
    // The result is longer than the cap due to the notice prefix.
    expect(result.length).toBeGreaterThan(SECTION_CHAR_CAP);
  });

  it('prepends a one-line notice with correct N (cap) and M (original length) values', () => {
    const originalLength = SECTION_CHAR_CAP + 1_000;
    const content = 'z'.repeat(originalLength);
    const result = compressSection(content);
    expect(result).toContain(
      `[… earlier content omitted — showing last ${String(SECTION_CHAR_CAP)} chars of ${String(originalLength)} total]`
    );
  });

  it('notice is followed by a blank line before the retained content', () => {
    const content = 'y'.repeat(SECTION_CHAR_CAP + 100);
    const result = compressSection(content);
    // Notice line ends with \n\n (blank line separator).
    const noticeEnd = result.indexOf(']\n\n');
    expect(noticeEnd).toBeGreaterThan(-1);
  });

  it('respects a custom cap', () => {
    const cap = 10;
    const content = 'abcdefghijklmnopqrstuvwxyz'; // 26 chars, above cap=10
    const result = compressSection(content, cap);
    // Tail: last 10 chars of content
    expect(result.endsWith('qrstuvwxyz')).toBe(true);
    expect(result).toContain(`showing last ${String(cap)} chars of ${String(content.length)} total`);
  });

  it('returns content unchanged when equal to custom cap', () => {
    const cap = 5;
    const content = 'hello';
    expect(compressSection(content, cap)).toBe(content);
  });

  it('does not drop content when content is exactly one char over the default cap', () => {
    const content = 'a'.repeat(SECTION_CHAR_CAP + 1);
    const result = compressSection(content);
    // The tail should be exactly SECTION_CHAR_CAP 'a's.
    const tail = 'a'.repeat(SECTION_CHAR_CAP);
    expect(result.endsWith(tail)).toBe(true);
    expect(result).toContain(`showing last ${String(SECTION_CHAR_CAP)} chars of ${String(SECTION_CHAR_CAP + 1)} total`);
  });

  it('survives a cap boundary that falls inside an emoji surrogate pair', () => {
    // '😀' is a UTF-16 surrogate pair (😀, length 2). With this content/cap the slice
    // boundary lands between the high and low halves of the second pair, so the tail begins with
    // a lone low surrogate. The result is still a valid JS string (lone surrogates are permitted)
    // and must carry the omission notice.
    const content = '😀😀😀'; // 6 UTF-16 code units
    const cap = 3; // boundary falls inside the second pair
    const result = compressSection(content, cap);
    expect(typeof result).toBe('string');
    expect(result).toContain(`showing last ${String(cap)} chars of ${String(content.length)} total`);
  });
});
