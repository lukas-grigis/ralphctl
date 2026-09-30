import { describe, expect, it } from 'vitest';
import { plateauWindowSize } from '@src/business/task/plateau-detection.ts';

describe('plateauWindowSize', () => {
  it('mirrors the predicate clamp — 2-5, truncating and defending against out-of-range knobs', () => {
    expect(plateauWindowSize(0)).toBe(2);
    expect(plateauWindowSize(1)).toBe(2);
    expect(plateauWindowSize(2)).toBe(2);
    expect(plateauWindowSize(3)).toBe(3);
    expect(plateauWindowSize(5)).toBe(5);
    expect(plateauWindowSize(9)).toBe(5);
    expect(plateauWindowSize(3.9)).toBe(3);
    expect(plateauWindowSize(Number.NaN)).toBe(2);
  });
});
