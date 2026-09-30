import { describe, expect, it } from 'vitest';
import {
  APPROX_MIN_ITEMS,
  ci95,
  estimateOmega2,
  flipRate,
  itemScore,
  kSufficiency,
  mde,
  pairedDiff,
  passAtK,
  passHatK,
  sampleVariance,
  seClt,
  seClustered,
  sePaired,
  summarize,
  Z_ALPHA_HALF,
  Z_BETA,
} from '../../../../scripts/eval/stats.ts';

/**
 * Every expectation below is computed by hand from Miller, arXiv 2411.00640 (equation numbers are
 * the paper's), not by re-running the implementation.
 */
describe('Eq. 1 — SE_CLT', () => {
  it('matches the hand computation for [1,0,1,1]', () => {
    // mean .75, Σ(s-s̄)² = .0625+.5625+.0625+.0625 = .75, var = .75/3 = .25, SE = sqrt(.25/4) = .25
    expect(seClt([1, 0, 1, 1])).toBeCloseTo(0.25, 10);
  });

  it('is undefined for fewer than two items', () => {
    expect(seClt([1])).toBeNaN();
  });

  it('sampleVariance uses the n-1 denominator', () => {
    expect(sampleVariance([1, 3])).toBe(2);
  });
});

describe('Eq. 3 — 95% CI', () => {
  it('is s̄ ± 1.96 × SE', () => {
    const [lo, hi] = ci95(0.75, 0.25);
    expect(lo).toBeCloseTo(0.26, 10);
    expect(hi).toBeCloseTo(1.24, 10);
  });
});

describe('Eq. 4 — clustered SE', () => {
  it('adds the within-cluster cross terms', () => {
    // scores [1,1,0,0], clusters {a,a,b,b}: SE_CLT² = 1/12; cross = (1-.5)+(1-.5) = 1 → 1/16.
    expect(seClustered([1, 1, 0, 0], ['a', 'a', 'b', 'b'])).toBeCloseTo(Math.sqrt(1 / 12 + 1 / 16), 10);
  });

  it('equals Eq. 1 when every cluster is a singleton', () => {
    const scores = [1, 0, 1, 1, 0];
    expect(seClustered(scores, ['a', 'b', 'c', 'd', 'e'])).toBeCloseTo(seClt(scores), 10);
  });

  it('is at least the naive SE when scores within a cluster agree', () => {
    const scores = [1, 1, 0, 0];
    expect(seClustered(scores, ['a', 'a', 'b', 'b'])).toBeGreaterThan(seClt(scores));
  });

  it('shrinks below the naive SE when scores within a cluster disagree', () => {
    // [1,0,1,0] in clusters {a,a,b,b}: SE_CLT² = 1/12; cross = (0-.5)+(0-.5) = -1 → -1/16.
    const scores = [1, 0, 1, 0];
    const clustered = seClustered(scores, ['a', 'a', 'b', 'b']);
    expect(clustered).toBeCloseTo(Math.sqrt(1 / 12 - 1 / 16), 10);
    expect(clustered).toBeLessThan(seClt(scores));
  });
});

describe('Eq. 7 — paired SE', () => {
  it('matches the hand computation over item differences', () => {
    // d = B - A = [0,-1,1,1]; d̄ = .25; Σ(d-d̄)² = 2.75; var = 2.75/3; SE = sqrt(var/4)
    const a = [1, 1, 0, 0];
    const b = [1, 0, 1, 1];
    const expected = Math.sqrt(2.75 / 3 / 4);
    expect(sePaired([0, -1, 1, 1])).toBeCloseTo(expected, 10);
    const paired = pairedDiff(a, b, ['a', 'b', 'c', 'd']);
    expect(paired.meanDiff).toBeCloseTo(0.25, 10);
    expect(paired.se).toBeCloseTo(expected, 10);
    expect(paired.z).toBeCloseTo(0.25 / expected, 10);
  });

  it('calls a difference detectable only when the CI excludes 0', () => {
    const noisy = pairedDiff([1, 1, 0, 0], [1, 0, 1, 1], ['a', 'b', 'c', 'd']);
    expect(noisy.ci[0]).toBeLessThan(0);
    expect(noisy.detectable).toBe(false);
    const steady = pairedDiff([0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 0.9, 1.1], ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(steady.detectable).toBe(true);
  });

  it('flags fewer than 30 paired items as approximate and 30+ as not — the same n rule as summarize', () => {
    const n = (count: number): { a: number[]; b: number[]; c: string[] } => ({
      a: Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 1 : 0)),
      b: Array.from({ length: count }, (_, i) => (i % 3 === 0 ? 1 : 0)),
      c: Array.from({ length: count }, (_, i) => String(i)),
    });
    const below = n(APPROX_MIN_ITEMS - 1);
    const at = n(APPROX_MIN_ITEMS);
    expect(pairedDiff(below.a, below.b, below.c).approx).toBe(true);
    expect(pairedDiff(at.a, at.b, at.c).approx).toBe(false);
  });
});

describe('summarize', () => {
  it('flags s̄ ∈ {0,1} as degenerate: SE 0, no interval, approx', () => {
    const s = summarize([1, 1, 1, 1], ['a', 'b', 'c', 'd']);
    expect(s.se).toBe(0);
    expect(s.ci).toBeNull();
    expect(s.approx).toBe(true);
  });

  it('flags fewer than 30 items as approximate and 30+ as not', () => {
    const many = (n: number): number[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : 0));
    const clusters = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i));
    expect(summarize(many(APPROX_MIN_ITEMS - 1), clusters(APPROX_MIN_ITEMS - 1)).approx).toBe(true);
    expect(summarize(many(APPROX_MIN_ITEMS), clusters(APPROX_MIN_ITEMS)).approx).toBe(false);
  });

  it('reports no SE for a single item', () => {
    expect(summarize([1], ['a'])).toMatchObject({ n: 1, se: null, ci: null, approx: true });
  });
});

describe('item-level aggregates', () => {
  const items = [
    [true, true, true],
    [true, false, true],
    [false, false, false],
  ];

  it('item score is the mean of the k trials', () => {
    expect(itemScore([true, false, true, true])).toBe(0.75);
  });

  it('pass@k, pass^k and flip rate', () => {
    expect(passAtK(items)).toBeCloseTo(2 / 3, 10);
    expect(passHatK(items)).toBeCloseTo(1 / 3, 10);
    expect(flipRate(items)).toBeCloseTo(1 / 3, 10);
  });

  it("matches Anthropic's worked example: 75% per trial over 3 trials passes all three ≈ 42%", () => {
    expect(0.75 ** 3).toBeCloseTo(0.4219, 4);
  });

  it('k-sufficiency prints E[σ²_i]/K beside Var(s)', () => {
    // item variances (n-1): [0, 1/3, 0] → mean 1/9; /K=3 → 1/27. Item scores [1, 2/3, 0].
    const s = kSufficiency(items, 3);
    expect(s.meanWithinVariance).toBeCloseTo(1 / 9, 10);
    expect(s.withinOverK).toBeCloseTo(1 / 27, 10);
    expect(s.scoreVariance).toBeCloseTo(sampleVariance([1, 2 / 3, 0]), 10);
  });
});

describe('Eq. 9 — minimum detectable effect', () => {
  it("reproduces Miller's worked example (ω²=1/9, σ²=0, δ=.03 ⇒ n≈969)", () => {
    const n = ((Z_ALPHA_HALF + Z_BETA) ** 2 * (1 / 9)) / 0.03 ** 2;
    expect(Math.round(n)).toBe(969);
    expect(mde(1 / 9, 0, 1, 0, 1, 969)).toBeCloseTo(0.03, 4);
  });

  it('shrinks with the square root of n and grows with resampling noise', () => {
    const base = mde(0.1, 0.2, 3, 0.2, 3, 10);
    expect(mde(0.1, 0.2, 3, 0.2, 3, 40)).toBeCloseTo(base / 2, 10);
    expect(mde(0.1, 0.4, 3, 0.4, 3, 10)).toBeGreaterThan(base);
  });

  it('estimates ω² as the difference variance minus the resampling terms, floored at 0', () => {
    // Var([0, 2]) = 2; subtracting 1/1 + 1/1 leaves 0 (floored); subtracting nothing leaves 2.
    expect(estimateOmega2([0, 2], 0, 1, 0, 1)).toBe(2);
    expect(estimateOmega2([0, 2], 1, 1, 1, 1)).toBe(0);
  });
});
