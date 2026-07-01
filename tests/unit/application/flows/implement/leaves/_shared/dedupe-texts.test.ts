import { describe, expect, it } from 'vitest';
import { dedupeTexts } from '@src/application/flows/implement/leaves/_shared/dedupe-texts.ts';

/**
 * `dedupeTexts` folds a per-attempt signal-text accumulator (changes / decisions / notes) into a
 * trimmed, deduped, first-seen-order list. Shared by the progress-journal and append-learnings
 * leaves.
 */

describe('dedupeTexts', () => {
  it('returns an empty array for undefined input', () => {
    expect(dedupeTexts(undefined)).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeTexts([])).toEqual([]);
  });

  it('trims whitespace around each entry', () => {
    expect(dedupeTexts(['  added X  ', '\trenamed Y to Z\n'])).toEqual(['added X', 'renamed Y to Z']);
  });

  it('drops empty / whitespace-only entries', () => {
    expect(dedupeTexts(['added X', '', '   ', 'renamed Y'])).toEqual(['added X', 'renamed Y']);
  });

  it('dedupes on the trimmed text, keeping first-seen order', () => {
    expect(dedupeTexts(['added X', 'renamed Y', '  added X  ', 'added X', 'renamed Y'])).toEqual([
      'added X',
      'renamed Y',
    ]);
  });
});
