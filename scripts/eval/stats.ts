/**
 * Pure statistics for the eval harness. Every estimator here is quoted from Miller, "Adding Error
 * Bars to Evals: A Statistical Approach to Language Model Evaluations" (arXiv 2411.00640) — the
 * equation numbers below are that paper's. Nothing here does I/O.
 *
 * Vocabulary: an ITEM is one (fixture, variant); a TRIAL is one of the k repeats of an item. The
 * item score s_i is the mean of its trials' binary `correct` values — Miller §3.1: "the score s_i is
 * the mean of these K answer scores". Standard errors are computed over item scores, never over the
 * pooled k·n trials, because "computing a pooled standard error across all KN answers will be
 * inconsistent, as multiple answers to the same question would violate the assumption of
 * independent draws".
 *
 * Engineering judgment, not from the paper: the `approx` thresholds (n < 30, mean ∈ {0, 1}) and the
 * fixed α = .05 / β = .2 for {@link mde}. Miller gives the CLT interval, not a small-sample method;
 * no Wilson / exact interval is offered here because none was consulted.
 */

/** z_{α/2} for α = .05 and z_β for β = .2 — standard-normal quantiles (Miller Eq. 9 inputs). */
export const Z_ALPHA_HALF = 1.959964;
export const Z_BETA = 0.841621;

/** Below this many items the CLT interval is flagged approximate (engineering judgment). */
export const APPROX_MIN_ITEMS = 30;

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? Number.NaN : sum(xs) / xs.length);

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Sample variance with the n-1 denominator; `NaN` for fewer than two values. */
export const sampleVariance = (xs: readonly number[]): number => {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
};

/** Item score: the mean of the item's binary trial outcomes (Miller §3.1). */
export const itemScore = (trials: readonly boolean[]): number => mean(trials.map((t) => (t ? 1 : 0)));

/** Eq. 1 — SE_CLT = sqrt( (1/(n-1) Σ (s_i - s̄)²) / n ). `NaN` when n < 2. */
export const seClt = (scores: readonly number[]): number => Math.sqrt(sampleVariance(scores) / scores.length);

/**
 * Eq. 4 — clustered standard error:
 * SE² = SE_CLT² + (1/n²) Σ_c Σ_i Σ_{j≠i} (s_i,c - s̄)(s_j,c - s̄).
 * `clusters[i]` names the cluster of `scores[i]`. With singleton clusters the triple sum is empty
 * and this reduces to Eq. 1. The radicand is non-negative in exact arithmetic (the cross terms are
 * bounded below by -Σ(s_i - s̄)²/n², which the SE_CLT² term outweighs); the clamp only guards
 * floating-point error.
 */
export const seClustered = (scores: readonly number[], clusters: readonly string[]): number => {
  const n = scores.length;
  if (n < 2) return Number.NaN;
  const m = mean(scores);
  const byCluster = new Map<string, { sumDev: number; sumSq: number }>();
  scores.forEach((s, i) => {
    const key = clusters[i] ?? String(i);
    const dev = s - m;
    const acc = byCluster.get(key) ?? { sumDev: 0, sumSq: 0 };
    acc.sumDev += dev;
    acc.sumSq += dev * dev;
    byCluster.set(key, acc);
  });
  let cross = 0;
  for (const { sumDev, sumSq } of byCluster.values()) cross += sumDev * sumDev - sumSq;
  const variance = seClt(scores) ** 2 + cross / (n * n);
  return Math.sqrt(Math.max(0, variance));
};

/** Eq. 3 — CI_95% = s̄ ± 1.96 × SE. */
export const ci95 = (m: number, se: number): readonly [number, number] => [m - 1.96 * se, m + 1.96 * se];

/** Eq. 7 — paired SE = sqrt( (1/(n-1) Σ (d_i - d̄)²) / n ) over the per-item differences. */
export const sePaired = (diffs: readonly number[]): number => seClt(diffs);

export interface PairedDiff {
  readonly n: number;
  readonly meanDiff: number;
  readonly se: number;
  readonly ci: readonly [number, number];
  /** Eq. 6 — z = d̄ / SE. */
  readonly z: number;
  /** The interval excludes 0 — the harness's "detectable difference" rule (engineering judgment). */
  readonly detectable: boolean;
  /** Fewer than {@link APPROX_MIN_ITEMS} paired items — the same n rule {@link summarize} applies. */
  readonly approx: boolean;
}

/**
 * Paired analysis over per-item differences d_i = s_B,i - s_A,i (Miller §4.2). The SE is Eq. 4
 * applied to the differences, which reduces to Eq. 7 when every cluster is a singleton. Miller's
 * own clustered-paired form is Eq. 8, (1/n)·sqrt(ΣΣ(d_i-d̄)(d_j-d̄)); it differs from this only by
 * the small-sample n/(n-1) factor on the diagonal terms.
 */
export const pairedDiff = (a: readonly number[], b: readonly number[], clusters: readonly string[]): PairedDiff => {
  const diffs = a.map((sa, i) => (b[i] ?? Number.NaN) - sa);
  const meanDiff = mean(diffs);
  const se = seClustered(diffs, clusters);
  const ci = ci95(meanDiff, se);
  return {
    n: diffs.length,
    meanDiff,
    se,
    ci,
    z: meanDiff / se,
    detectable: Number.isFinite(se) && (ci[0] > 0 || ci[1] < 0),
    approx: diffs.length < APPROX_MIN_ITEMS,
  };
};

/** Share of items with at least one correct trial (Anthropic's pass@k definition). */
export const passAtK = (items: readonly (readonly boolean[])[]): number =>
  mean(items.map((trials) => (trials.some(Boolean) ? 1 : 0)));

/** Share of items whose every trial is correct — "the probability that all k trials succeed" (pass^k). */
export const passHatK = (items: readonly (readonly boolean[])[]): number =>
  mean(items.map((trials) => (trials.every(Boolean) ? 1 : 0)));

/** Share of items whose trials disagree with each other. */
export const flipRate = (items: readonly (readonly boolean[])[]): number =>
  mean(items.map((trials) => (trials.some(Boolean) && !trials.every(Boolean) ? 1 : 0)));

export interface KSufficiency {
  /** mean over items of the within-item trial variance σ_i² (n-1 denominator). */
  readonly meanWithinVariance: number;
  /** E[σ_i²] / K — Miller: once this is ≪ Var(x), "increasing K further will have little effect". */
  readonly withinOverK: number;
  /** Var(s) — the variance of item scores, printed beside it. */
  readonly scoreVariance: number;
  readonly k: number;
}

/** The k-sufficiency line: E[σ_i²]/K printed beside Var(s). `NaN` fields when k < 2 or n < 2. */
export const kSufficiency = (items: readonly (readonly boolean[])[], k: number): KSufficiency => {
  const within = items.map((trials) => sampleVariance(trials.map((t) => (t ? 1 : 0)))).filter(Number.isFinite);
  const meanWithinVariance = mean(within);
  return {
    meanWithinVariance,
    withinOverK: meanWithinVariance / k,
    scoreVariance: sampleVariance(items.map(itemScore)),
    k,
  };
};

/**
 * ω² = Var(x_A) + Var(x_B) - 2 Cov(x_A, x_B) (Miller §5), estimated from this run's data. The
 * variance of the item-level score differences decomposes as ω² + σ_A²/K_A + σ_B²/K_B, so ω² is
 * that variance minus the two resampling terms, floored at 0. The estimator is engineering
 * judgment; Miller only says these quantities "may be estimated from previous eval data".
 */
export const estimateOmega2 = (
  diffs: readonly number[],
  sigmaA2: number,
  kA: number,
  sigmaB2: number,
  kB: number
): number => Math.max(0, sampleVariance(diffs) - sigmaA2 / kA - sigmaB2 / kB);

/**
 * Eq. 9 rearranged for the Minimum Detectable Effect at a fixed n:
 * δ = (z_{α/2} + z_β) · sqrt( (ω² + σ_A²/K_A + σ_B²/K_B) / n ), with α = .05 and β = .2.
 */
export const mde = (omega2: number, sigmaA2: number, kA: number, sigmaB2: number, kB: number, n: number): number =>
  (Z_ALPHA_HALF + Z_BETA) * Math.sqrt((omega2 + sigmaA2 / kA + sigmaB2 / kB) / n);

export interface Summary {
  readonly n: number;
  readonly mean: number;
  /** `null` when n < 2 (SE undefined). */
  readonly se: number | null;
  /** `null` when the interval is degenerate (SE 0 or undefined). */
  readonly ci: readonly [number, number] | null;
  /** True when n < 30 or the mean is 0 / 1 — the CLT interval is a rough guide only. */
  readonly approx: boolean;
}

/** Mean + clustered SE + 95% CI of item scores, with the `approx` flag. */
export const summarize = (scores: readonly number[], clusters: readonly string[]): Summary => {
  const n = scores.length;
  const m = mean(scores);
  if (n < 2) return { n, mean: m, se: null, ci: null, approx: true };
  const se = seClustered(scores, clusters);
  const degenerate = !Number.isFinite(se) || se === 0;
  return {
    n,
    mean: m,
    se: Number.isFinite(se) ? se : null,
    ci: degenerate ? null : ci95(m, se),
    approx: n < APPROX_MIN_ITEMS || m === 0 || m === 1,
  };
};
