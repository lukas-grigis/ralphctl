import { describe, expect, it } from 'vitest';
import { computeActionEntropy, detectLowEntropy } from '@src/business/task/escalation-policy.ts';

describe('computeActionEntropy', () => {
  it('returns 1 for an empty map (no data → max diversity assumed)', () => {
    expect(computeActionEntropy(new Map())).toBe(1);
  });

  it('returns 0 for a single action kind (zero diversity)', () => {
    const counts = new Map([['bash', 10]]);
    expect(computeActionEntropy(counts)).toBe(0);
  });

  it('returns 1 for a two-kind uniform distribution', () => {
    const counts = new Map([
      ['edit', 5],
      ['bash', 5],
    ]);
    expect(computeActionEntropy(counts)).toBeCloseTo(1, 10);
  });

  it('returns 1 for a four-kind uniform distribution', () => {
    const counts = new Map([
      ['edit', 3],
      ['bash', 3],
      ['read', 3],
      ['write', 3],
    ]);
    expect(computeActionEntropy(counts)).toBeCloseTo(1, 10);
  });

  it('returns 0.5 for a two-of-four distribution where only 2 kinds are used uniformly', () => {
    // 2 of 4 kinds used equally: normalised entropy = log2(2)/log2(4) = 1/2 = 0.5
    const counts = new Map([
      ['edit', 5],
      ['bash', 5],
      ['read', 0],
      ['write', 0],
    ]);
    // K=4 (4 distinct keys), but p(read)=0 and p(write)=0 → H raw = -2*(0.5*log2(0.5)) = 1
    // normalised = 1 / log2(4) = 1/2 = 0.5
    expect(computeActionEntropy(counts)).toBeCloseTo(0.5, 10);
  });

  it('returns 1 for a map where all counts are zero (treated as no data)', () => {
    const counts = new Map([
      ['edit', 0],
      ['bash', 0],
    ]);
    expect(computeActionEntropy(counts)).toBe(1);
  });

  it('returns a value between 0 and 1 for a skewed distribution', () => {
    const counts = new Map([
      ['bash', 9],
      ['edit', 1],
    ]);
    const e = computeActionEntropy(counts);
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(1);
  });

  it('is symmetric — swapping counts does not change entropy', () => {
    const a = new Map([
      ['bash', 7],
      ['edit', 3],
    ]);
    const b = new Map([
      ['edit', 7],
      ['bash', 3],
    ]);
    expect(computeActionEntropy(a)).toBeCloseTo(computeActionEntropy(b), 10);
  });
});

describe('detectLowEntropy', () => {
  it('returns true when entropy is below the default threshold (0.25)', () => {
    expect(detectLowEntropy(0.0)).toBe(true);
    expect(detectLowEntropy(0.1)).toBe(true);
    expect(detectLowEntropy(0.24)).toBe(true);
  });

  it('returns false when entropy equals or exceeds the default threshold', () => {
    expect(detectLowEntropy(0.25)).toBe(false);
    expect(detectLowEntropy(0.5)).toBe(false);
    expect(detectLowEntropy(1.0)).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(detectLowEntropy(0.3, 0.4)).toBe(true);
    expect(detectLowEntropy(0.4, 0.4)).toBe(false);
  });

  it('clamps threshold below 0.1 to 0.1', () => {
    // With threshold clamped to 0.1, entropy=0.05 is low but entropy=0.15 is not.
    expect(detectLowEntropy(0.05, 0.0)).toBe(true);
    expect(detectLowEntropy(0.15, 0.0)).toBe(false);
  });

  it('clamps threshold above 0.5 to 0.5', () => {
    // With threshold clamped to 0.5, entropy=0.49 is low and entropy=0.5 is not.
    expect(detectLowEntropy(0.49, 0.9)).toBe(true);
    expect(detectLowEntropy(0.5, 0.9)).toBe(false);
  });

  it('returns false for max-diversity entropy (1.0) with any valid threshold', () => {
    expect(detectLowEntropy(1.0, 0.1)).toBe(false);
    expect(detectLowEntropy(1.0, 0.5)).toBe(false);
  });
});
