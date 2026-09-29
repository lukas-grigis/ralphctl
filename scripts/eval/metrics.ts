import type { EvalFlow } from './fixture-schema.ts';
import {
  estimateOmega2,
  flipRate as flipRateOf,
  mde,
  mean,
  pairedDiff,
  passAtK as passAtKOf,
  passHatK as passHatKOf,
  sampleVariance,
  summarize,
} from './stats.ts';
import type { ComparisonRow, MetricRow, TrialRecord, UsageSummary } from './types.ts';

/**
 * Trials → metric rows and A/B comparison. Pure. The unit of analysis is the ITEM, never the
 * trial: an item is one (fixture, variant) — or, for select-candidate, one fixture across both
 * candidate orders — and its score is the mean of its k graded trials (Miller, arXiv 2411.00640 §3.1).
 * Items with fewer graded trials than expected are `incomplete` and excluded from stats and pairing.
 */

export interface Item {
  readonly key: string;
  readonly flow: EvalFlow;
  readonly cluster: string;
  readonly origin: 'synthetic' | 'real';
  readonly tier: 'regression' | 'capability';
  readonly isDefect: boolean;
  readonly trials: readonly TrialRecord[];
  /** Graded trials this item was supposed to get: k, or 2k for select-candidate (two orders). */
  readonly expected: number;
}

export const itemKeyOf = (t: Pick<TrialRecord, 'flow' | 'fixtureId' | 'variant'>): string =>
  t.flow === 'select-candidate' ? t.fixtureId : `${t.fixtureId}/${t.variant}`;

export const expectedTrialsPerItem = (flow: EvalFlow, k: number): number => (flow === 'select-candidate' ? 2 * k : k);

/** Group one arm's trials into items; errored (ungraded) trials are kept out of `trials` but count against completeness. */
export const groupItems = (trials: readonly TrialRecord[], arm: string, k: number): readonly Item[] => {
  const byKey = new Map<string, TrialRecord[]>();
  for (const t of trials) {
    if (t.arm !== arm) continue;
    const key = itemKeyOf(t);
    byKey.set(key, [...(byKey.get(key) ?? []), t]);
  }
  return [...byKey.entries()].map(([key, all]) => {
    const first = all[0] as TrialRecord;
    return {
      key,
      flow: first.flow,
      cluster: first.cluster,
      origin: first.origin,
      tier: first.tier,
      isDefect: first.defectClass !== undefined,
      trials: all.filter((t) => t.graded),
      expected: expectedTrialsPerItem(first.flow, k),
    };
  });
};

export const isComplete = (item: Item): boolean => item.trials.length >= item.expected;

interface MetricDef {
  readonly name: string;
  readonly filter?: (item: Item) => boolean;
  /** Per-trial value; the item value is their mean. Also feeds the within-item variance for MDE. */
  readonly trialValue?: (t: TrialRecord) => number | undefined;
  /** Item-level value computed from all the item's trials (pass@k and friends). */
  readonly itemValue?: (item: Item) => number | undefined;
}

const bit = (b: boolean): number => (b ? 1 : 0);
const boolsOf = (item: Item): boolean[] => item.trials.map((t) => t.correct);

const COMMON: readonly MetricDef[] = [
  { name: 'correct', trialValue: (t) => bit(t.correct) },
  { name: 'structural-valid-first-try', trialValue: (t) => bit(t.structurallyValid && t.nudgeCount === 0) },
  { name: 'structural-valid-after-nudges', trialValue: (t) => bit(t.structurallyValid) },
  { name: 'pass@k', itemValue: (i) => passAtKOf([boolsOf(i)]) },
  { name: 'pass^k', itemValue: (i) => passHatKOf([boolsOf(i)]) },
  { name: 'flip-rate', itemValue: (i) => flipRateOf([boolsOf(i)]) },
];

const gradeBool = (pick: (g: NonNullable<TrialRecord['grade']>) => boolean | null | undefined) => (t: TrialRecord) => {
  const v = t.grade === undefined ? undefined : pick(t.grade);
  return v === null || v === undefined ? undefined : bit(v);
};

const EVALUATE: readonly MetricDef[] = [
  { name: 'catch-rate', filter: (i) => i.isDefect, trialValue: (t) => bit(t.correct) },
  { name: 'false-pass-rate', filter: (i) => i.isDefect, trialValue: (t) => bit(!t.correct) },
  { name: 'false-fail-rate', filter: (i) => !i.isDefect, trialValue: (t) => bit(!t.correct) },
  {
    name: 'dimension-hit',
    trialValue: gradeBool((g) => (g.flow === 'evaluate' ? g.dimensionHit : undefined)),
  },
  {
    name: 'unverified-compliance',
    trialValue: gradeBool((g) => (g.flow === 'evaluate' ? g.unverifiedCompliance : undefined)),
  },
  ...(['synthetic', 'real'] as const).map((origin): MetricDef => ({
    name: `catch-rate[${origin}]`,
    filter: (i) => i.isDefect && i.origin === origin,
    trialValue: (t) => bit(t.correct),
  })),
];

const IMPLEMENT: readonly MetricDef[] = [
  { name: 'false-completion', trialValue: gradeBool((g) => (g.flow === 'implement' ? g.falseCompletion : undefined)) },
];

const DETECT: readonly MetricDef[] = [
  { name: 'exact-match', trialValue: gradeBool((g) => (g.flow === 'detect-scripts' ? g.exactMatch : undefined)) },
];

/** Both orders picked the same candidate (and neither tied): the pair-wise position-bias check. */
const orderAgreement = (item: Item): number | undefined => {
  const pickOf = (order: string): (string | undefined)[] =>
    item.trials
      .filter((t) => t.variant === order)
      .sort((a, b) => a.trialIndex - b.trialIndex)
      .map((t) => (t.grade?.flow === 'select-candidate' ? t.grade.picked : undefined));
  const ab = pickOf('ab');
  const ba = pickOf('ba');
  const pairs = Math.min(ab.length, ba.length);
  if (pairs === 0) return undefined;
  let agree = 0;
  for (let j = 0; j < pairs; j++) {
    const x = ab[j];
    if (x !== undefined && x !== 'none' && x !== 'tie' && x === ba[j]) agree++;
  }
  return agree / pairs;
};

const SELECT: readonly MetricDef[] = [{ name: 'order-agreement', itemValue: orderAgreement }];

const FLOW_METRICS: Readonly<Record<EvalFlow, readonly MetricDef[]>> = {
  evaluate: EVALUATE,
  implement: IMPLEMENT,
  'detect-scripts': DETECT,
  'select-candidate': SELECT,
};

const metricsFor = (flow: EvalFlow): readonly MetricDef[] => [...COMMON, ...FLOW_METRICS[flow]];

interface ItemValue {
  readonly key: string;
  readonly cluster: string;
  readonly value: number;
  readonly trialValues: readonly number[];
  readonly expected: number;
}

/** Item-level values for one metric over the COMPLETE items that pass the metric's filter. */
const itemValues = (def: MetricDef, items: readonly Item[]): readonly ItemValue[] => {
  const out: ItemValue[] = [];
  for (const item of items) {
    if (!isComplete(item) || (def.filter !== undefined && !def.filter(item))) continue;
    const trialValues =
      def.trialValue === undefined ? [] : item.trials.map(def.trialValue).filter((v): v is number => v !== undefined);
    const value =
      def.itemValue !== undefined ? def.itemValue(item) : trialValues.length > 0 ? mean(trialValues) : undefined;
    if (value === undefined || !Number.isFinite(value)) continue;
    out.push({ key: item.key, cluster: item.cluster, value, trialValues, expected: item.expected });
  }
  return out;
};

const rowOf = (name: string, values: readonly ItemValue[]): MetricRow => {
  const s = summarize(
    values.map((v) => v.value),
    values.map((v) => v.cluster)
  );
  return { name, n: s.n, mean: s.mean, se: s.se, ci: s.ci, approx: s.approx };
};

/** Metric rows for one flow × arm, over complete items only. */
export const metricRows = (flow: EvalFlow, items: readonly Item[]): readonly MetricRow[] =>
  metricsFor(flow)
    .map((def) => ({
      def,
      values: itemValues(
        def,
        items.filter((i) => i.flow === flow)
      ),
    }))
    .filter(({ values }) => values.length > 0)
    .map(({ def, values }) => rowOf(def.name, values));

/**
 * `<arm>:<item>` for every PLANNED item without its full set of graded trials — including items a
 * budget stop never reached, which have no trials at all.
 */
export const incompleteItems = (
  arm: string,
  items: readonly Item[],
  plannedKeys: readonly string[]
): readonly string[] =>
  plannedKeys.filter((key) => !items.some((i) => i.key === key && isComplete(i))).map((key) => `${arm}:${key}`);

/**
 * Per-arm, per-flow metric rows and usage recomputed from raw trials — the one place `run` and
 * `report` derive them, so an arm's numbers always come from its own trials (never a stored map
 * keyed by an arm name another run also used). `incomplete` lists planned-but-unfinished items.
 */
export const summarizeArms = (
  trials: readonly TrialRecord[],
  armNames: readonly string[],
  k: number,
  plannedKeys: readonly string[]
): {
  readonly metrics: Record<string, Record<string, readonly MetricRow[]>>;
  readonly usage: Record<string, Record<string, UsageSummary>>;
  readonly incomplete: readonly string[];
} => {
  const flows = [...new Set(trials.map((t) => t.flow))];
  const metrics: Record<string, Record<string, readonly MetricRow[]>> = {};
  const usage: Record<string, Record<string, UsageSummary>> = {};
  const incomplete: string[] = [];
  for (const arm of armNames) {
    const items = groupItems(trials, arm, k);
    incomplete.push(...incompleteItems(arm, items, plannedKeys));
    for (const flow of flows) {
      const rows = metricRows(flow, items);
      if (rows.length > 0) (metrics[flow] ??= {})[arm] = rows;
      const armFlowTrials = trials.filter((t) => t.arm === arm && t.flow === flow);
      if (armFlowTrials.length > 0) (usage[flow] ??= {})[arm] = usageSummary(armFlowTrials);
    }
  }
  return { metrics, usage, incomplete };
};

export const usageSummary = (trials: readonly TrialRecord[]): UsageSummary => {
  const known = (pick: (t: TrialRecord) => number | null): number | null => {
    const values = trials.map(pick).filter((v): v is number => v !== null);
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
  };
  const inputTokens = known((t) => t.usage.inputTokens);
  const outputTokens = known((t) => t.usage.outputTokens);
  const cacheReadTokens = known((t) => t.usage.cacheReadTokens ?? null);
  const cacheCreationTokens = known((t) => t.usage.cacheCreationTokens ?? null);
  const wallMs = trials.reduce((a, t) => a + t.usage.durationMs, 0);
  const n = trials.length;
  return {
    trials: n,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    meanInputTokens: inputTokens === null ? null : inputTokens / n,
    meanOutputTokens: outputTokens === null ? null : outputTokens / n,
    meanCacheReadTokens: cacheReadTokens === null ? null : cacheReadTokens / n,
    meanCacheCreationTokens: cacheCreationTokens === null ? null : cacheCreationTokens / n,
    wallMs,
    meanWallMs: n === 0 ? 0 : wallMs / n,
    unmeteredTrials: trials.filter((t) => !t.usage.metered).length,
  };
};

const withinVariance = (values: readonly ItemValue[]): number => {
  const vars = values.map((v) => sampleVariance(v.trialValues)).filter(Number.isFinite);
  return vars.length === 0 ? 0 : mean(vars);
};

/**
 * Paired comparison A → B per flow and metric: items complete in BOTH arms, d_i = s_B,i - s_A,i,
 * clustered SE (Miller Eq. 4 on the differences), CI and detectability, plus the minimum detectable
 * effect at this n (Eq. 9 rearranged). Metrics with no trial-level values (pass@k, …) get a
 * comparison but no MDE — their within-item variance is undefined — so their MDE is reported as NaN.
 */
export const compareArms = (
  trials: readonly TrialRecord[],
  armA: string,
  armB: string,
  k: number,
  flows: readonly EvalFlow[]
): readonly ComparisonRow[] => {
  const itemsA = groupItems(trials, armA, k);
  const itemsB = groupItems(trials, armB, k);
  const rows: ComparisonRow[] = [];
  for (const flow of flows) {
    for (const def of metricsFor(flow)) {
      const a = new Map(
        itemValues(
          def,
          itemsA.filter((i) => i.flow === flow)
        ).map((v) => [v.key, v])
      );
      const b = new Map(
        itemValues(
          def,
          itemsB.filter((i) => i.flow === flow)
        ).map((v) => [v.key, v])
      );
      const shared = [...a.keys()].filter((key) => b.has(key)).sort();
      if (shared.length < 2) continue;
      const av = shared.map((key) => a.get(key) as ItemValue);
      const bv = shared.map((key) => b.get(key) as ItemValue);
      const paired = pairedDiff(
        av.map((v) => v.value),
        bv.map((v) => v.value),
        av.map((v) => v.cluster)
      );
      const kA = av[0]?.expected ?? k;
      const kB = bv[0]?.expected ?? k;
      const sigmaA2 = withinVariance(av);
      const sigmaB2 = withinVariance(bv);
      const omega2 = estimateOmega2(
        bv.map((v, i) => v.value - (av[i] as ItemValue).value),
        sigmaA2,
        kA,
        sigmaB2,
        kB
      );
      rows.push({
        flow,
        metric: def.name,
        n: paired.n,
        meanDiff: paired.meanDiff,
        se: paired.se,
        ci: paired.ci,
        detectable: paired.detectable,
        mde: def.trialValue === undefined ? Number.NaN : mde(omega2, sigmaA2, kA, sigmaB2, kB, paired.n),
      });
    }
  }
  return rows;
};
