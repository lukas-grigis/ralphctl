import { describe, expect, it } from 'vitest';
import { normalizeRefs } from '@src/domain/value/external-ref.ts';

describe('normalizeRefs', () => {
  it('returns an empty array for undefined input', () => {
    expect(normalizeRefs(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty input array', () => {
    expect(normalizeRefs([])).toEqual([]);
  });

  it('trims surrounding whitespace on each entry', () => {
    expect(normalizeRefs(['  #123  ', '\tPROJ-7\n'])).toEqual(['#123', 'PROJ-7']);
  });

  it('drops whitespace-only and empty entries', () => {
    expect(normalizeRefs(['#123', '', '   ', '\t', '!456'])).toEqual(['#123', '!456']);
  });

  it('dedupes repeated refs first-seen-wins, preserving input order', () => {
    expect(normalizeRefs(['#123', '!456', '#123', '!456', '#789'])).toEqual(['#123', '!456', '#789']);
  });

  it('treats trimmed equivalents as duplicates', () => {
    expect(normalizeRefs(['#123', '  #123  ', '#123\n'])).toEqual(['#123']);
  });

  it('returns empty when every entry is whitespace-only', () => {
    expect(normalizeRefs(['  ', '\t', ''])).toEqual([]);
  });
});
