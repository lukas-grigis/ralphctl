import { describe, expect, it } from 'vitest';
import { formatDiffStat } from '@src/domain/value/diff-stat.ts';

describe('formatDiffStat', () => {
  it('renders files and +/- line counts', () => {
    expect(formatDiffStat({ files: 5, insertions: 142, deletions: 38 })).toBe('5 files +142 -38');
  });

  it('uses the singular for one file and keeps zero counts', () => {
    expect(formatDiffStat({ files: 1, insertions: 0, deletions: 0 })).toBe('1 file +0 -0');
  });

  it('marks a partial stat as tracked files only', () => {
    expect(formatDiffStat({ files: 2, insertions: 3, deletions: 1, partial: true })).toBe(
      '2 files +3 -1 (tracked files only)'
    );
  });
});
