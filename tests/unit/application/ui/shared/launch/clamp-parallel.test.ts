/**
 * The parallel cap. `clampParallel` decides the implement dispatch: `=== 1` → serial path,
 * `> 1` → parallel worktree-fan-out path. The settings schema already validates `[1,5]`, but the
 * launcher re-clamps defensively so a hand-edited file or future schema change can't push past the
 * budget the wave scheduler (and provider rate limits) were sized against.
 */

import { describe, expect, it } from 'vitest';
import { clampParallel } from '@src/application/ui/shared/launch/implement.ts';

describe('clampParallel', () => {
  it('keeps 1 (serial default) unchanged', () => {
    expect(clampParallel(1)).toBe(1);
  });

  it('keeps in-range values 2..5', () => {
    expect(clampParallel(2)).toBe(2);
    expect(clampParallel(5)).toBe(5);
  });

  it('caps above 5 down to 5 (the hard ceiling)', () => {
    expect(clampParallel(6)).toBe(5);
    expect(clampParallel(100)).toBe(5);
  });

  it('floors below 1 up to 1', () => {
    expect(clampParallel(0)).toBe(1);
    expect(clampParallel(-3)).toBe(1);
  });

  it('truncates fractional values', () => {
    expect(clampParallel(3.9)).toBe(3);
  });

  it('falls back to 1 (serial) on a non-finite value', () => {
    expect(clampParallel(Number.NaN)).toBe(1);
    expect(clampParallel(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
