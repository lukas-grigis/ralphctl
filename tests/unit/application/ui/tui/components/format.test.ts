import { describe, expect, it } from 'vitest';
import { fitLineWithPath, middleTruncate } from '@src/application/ui/tui/components/format.ts';

describe('middleTruncate', () => {
  it('leaves a string that fits alone', () => {
    expect(middleTruncate('/a/b', 10)).toBe('/a/b');
  });

  it('cuts the middle to exactly the width, keeping both ends', () => {
    const out = middleTruncate('/Users/me/projects/deep/repo', 16);
    expect([...out]).toHaveLength(16);
    expect(out.startsWith('/Users/')).toBe(true);
    expect(out.endsWith('/repo')).toBe(true);
    expect(out).toContain('…');
  });
});

describe('fitLineWithPath', () => {
  const hint =
    'run `git -C /Users/me/Workzone/github/someone/some-long-repository-name remote set-head origin --auto` to discover it';

  it('middle-truncates the path so the words around it stay whole', () => {
    const out = fitLineWithPath(hint, 80);
    expect([...out].length).toBeLessThanOrEqual(80);
    expect(out).toContain('run `git -C /Users/');
    expect(out).toContain('remote set-head origin --auto` to discover it');
    expect(out).toContain('…');
  });

  it('returns a line that already fits unchanged', () => {
    expect(fitLineWithPath(hint, 200)).toBe(hint);
  });
});
