import { describe, expect, it } from 'vitest';
import {
  compareArms,
  expectedTrialsPerItem,
  groupItems,
  incompleteItems,
  itemKeyOf,
  metricRows,
  usageSummary,
} from '../../../../scripts/eval/metrics.ts';
import { itemTrials, trial } from '../../../fixtures/eval-trials.ts';

const row = (rows: ReturnType<typeof metricRows>, name: string) => rows.find((r) => r.name === name);

describe('item identity', () => {
  it('keys select-candidate by fixture (both orders share an item) and everything else by fixture/variant', () => {
    expect(itemKeyOf({ flow: 'select-candidate', fixtureId: 'sc-1', variant: 'ab' })).toBe('sc-1');
    expect(itemKeyOf({ flow: 'select-candidate', fixtureId: 'sc-1', variant: 'ba' })).toBe('sc-1');
    expect(itemKeyOf({ flow: 'evaluate', fixtureId: 'ev-1', variant: 'clean' })).toBe('ev-1/clean');
  });

  it('expects k trials per item, and 2k for select-candidate (two orders)', () => {
    expect(expectedTrialsPerItem('evaluate', 3)).toBe(3);
    expect(expectedTrialsPerItem('select-candidate', 3)).toBe(6);
  });
});

describe('metricRows', () => {
  const trials = [
    // two defect items (catch 1/1 and 0.5), one clean item (false-fail 1/3)
    ...itemTrials('d1', 'baseline', [true, true, true], { cluster: 'a' }),
    ...itemTrials('d2', 'baseline', [true, false, true, false].slice(0, 3), { cluster: 'b' }),
    ...itemTrials('k1', 'baseline', [true, true, false], { variant: 'clean', cluster: 'c' }).map((t) => {
      const { defectClass: _d, ...rest } = t;
      void _d;
      return rest;
    }),
  ];

  it('scores an item as the mean of its k trials and reports catch / false-fail by item kind', () => {
    const items = groupItems(trials, 'baseline', 3);
    const rows = metricRows('evaluate', items);
    expect(row(rows, 'correct')?.n).toBe(3);
    expect(row(rows, 'catch-rate')).toMatchObject({ n: 2 });
    expect(row(rows, 'catch-rate')?.mean).toBeCloseTo((1 + 2 / 3) / 2, 10);
    expect(row(rows, 'false-pass-rate')?.mean).toBeCloseTo(1 - (1 + 2 / 3) / 2, 10);
    expect(row(rows, 'false-fail-rate')).toMatchObject({ n: 1 });
    expect(row(rows, 'false-fail-rate')?.mean).toBeCloseTo(1 / 3, 10);
  });

  it('reports catch rate per origin', () => {
    const items = groupItems(
      [...itemTrials('real1', 'baseline', [false, false, false], { origin: 'real' }), ...trials],
      'baseline',
      3
    );
    const rows = metricRows('evaluate', items);
    expect(row(rows, 'catch-rate[real]')?.mean).toBe(0);
    expect(row(rows, 'catch-rate[synthetic]')?.n).toBe(2);
  });

  it('computes pass@k, pass^k and flip rate over items', () => {
    const rows = metricRows('evaluate', groupItems(trials, 'baseline', 3));
    expect(row(rows, 'pass@k')?.mean).toBe(1);
    expect(row(rows, 'pass^k')?.mean).toBeCloseTo(1 / 3, 10);
    expect(row(rows, 'flip-rate')?.mean).toBeCloseTo(2 / 3, 10);
  });

  it('separates first-try from after-nudge structural validity', () => {
    const t = [
      ...itemTrials('n1', 'baseline', [true, true, true]).map((x, i) => ({ ...x, nudgeCount: i === 0 ? 1 : 0 })),
    ];
    const rows = metricRows('evaluate', groupItems(t, 'baseline', 3));
    expect(row(rows, 'structural-valid-first-try')?.mean).toBeCloseTo(2 / 3, 10);
    expect(row(rows, 'structural-valid-after-nudges')?.mean).toBe(1);
  });

  it('leaves ungraded trials out of the score and marks the item incomplete', () => {
    const t = [
      ...itemTrials('e1', 'baseline', [true, true]),
      trial({ fixtureId: 'e1', trialIndex: 3, graded: false, correct: false, error: 'spawn failed' }),
    ];
    const items = groupItems(t, 'baseline', 3);
    expect(metricRows('evaluate', items)).toEqual([]);
    expect(incompleteItems('baseline', items, ['e1/defect'])).toEqual(['baseline:e1/defect']);
  });

  it('marks planned items a budget stop never reached as incomplete too', () => {
    const items = groupItems(itemTrials('e1', 'baseline', [true, true, true]), 'baseline', 3);
    expect(incompleteItems('baseline', items, ['e1/defect', 'e2/defect'])).toEqual(['baseline:e2/defect']);
  });

  it('reports order agreement for select-candidate', () => {
    const pick = (variant: 'ab' | 'ba', i: number, picked: 'a' | 'b' | 'tie'): ReturnType<typeof trial> =>
      trial({
        fixtureId: 'sc',
        flow: 'select-candidate',
        variant,
        trialIndex: i,
        correct: picked === 'a',
        grade: { flow: 'select-candidate', correct: picked === 'a', structurallyValid: true, picked },
      });
    const t = [pick('ab', 1, 'a'), pick('ba', 1, 'a'), pick('ab', 2, 'a'), pick('ba', 2, 'b')];
    const rows = metricRows('select-candidate', groupItems(t, 'baseline', 2));
    expect(row(rows, 'order-agreement')?.mean).toBe(0.5);
    expect(row(rows, 'correct')?.mean).toBe(0.75);
  });
});

describe('usageSummary', () => {
  it('sums reported tokens, never imputes missing ones, and counts unmetered trials', () => {
    const summary = usageSummary([
      trial(),
      trial({ usage: { inputTokens: null, outputTokens: null, durationMs: 500, metered: false } }),
    ]);
    expect(summary).toMatchObject({
      trials: 2,
      inputTokens: 100,
      outputTokens: 20,
      meanInputTokens: 50,
      wallMs: 1500,
      unmeteredTrials: 1,
    });
  });

  it('sums cache tokens separately, tolerating trials recorded before the fields existed', () => {
    const summary = usageSummary([
      trial({
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 900,
          cacheCreationTokens: 100,
          durationMs: 1,
          metered: true,
        },
      }),
      trial(), // legacy shape: no cache fields at all
    ]);
    expect(summary).toMatchObject({
      inputTokens: 110,
      cacheReadTokens: 900,
      cacheCreationTokens: 100,
      meanCacheReadTokens: 450,
      meanCacheCreationTokens: 50,
    });
    expect(usageSummary([trial()])).toMatchObject({ cacheReadTokens: null, meanCacheReadTokens: null });
  });

  it('reports null (n/a) when no trial reported tokens', () => {
    const summary = usageSummary([
      trial({ usage: { inputTokens: null, outputTokens: null, durationMs: 1, metered: false } }),
    ]);
    expect(summary).toMatchObject({ inputTokens: null, meanInputTokens: null });
  });
});

describe('compareArms', () => {
  const fixtures = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
  const build = (aScores: ReadonlyArray<readonly boolean[]>, bScores: ReadonlyArray<readonly boolean[]>) =>
    fixtures.flatMap((id, i) => [
      ...itemTrials(id, 'baseline', aScores[i] ?? [], { cluster: id }),
      ...itemTrials(id, 'candidate', bScores[i] ?? [], { cluster: id }),
    ]);

  it('pairs items complete in both arms and reports the mean difference', () => {
    const all = [false, false, false];
    const yes = [true, true, true];
    const rows = compareArms(
      build(
        fixtures.map(() => all),
        fixtures.map(() => yes)
      ),
      'baseline',
      'candidate',
      3,
      ['evaluate']
    );
    const correct = rows.find((r) => r.metric === 'correct');
    expect(correct).toMatchObject({ n: 6, meanDiff: 1, detectable: true, approx: true });
  });

  it('declares no detectable difference when the CI spans 0', () => {
    const a = [
      [true, true, true],
      [true, true, true],
      [false, false, false],
      [true, false, true],
      [false, true, false],
      [true, true, true],
    ];
    const b = [
      [true, true, true],
      [false, false, false],
      [true, true, true],
      [true, false, true],
      [true, true, false],
      [false, true, true],
    ];
    const rows = compareArms(build(a, b), 'baseline', 'candidate', 3, ['evaluate']);
    const correct = rows.find((r) => r.metric === 'correct');
    expect(correct?.detectable).toBe(false);
    expect(correct?.mde).toBeGreaterThan(0);
  });

  it('leaves out an item that is incomplete in either arm', () => {
    const yes = [true, true, true];
    const a = fixtures.map(() => yes);
    const b = fixtures.map((_, i) => (i === 0 ? [true] : yes)); // f1 has 1/3 trials in candidate
    const rows = compareArms(build(a, b), 'baseline', 'candidate', 3, ['evaluate']);
    expect(rows.find((r) => r.metric === 'correct')?.n).toBe(5);
  });

  it('skips a metric with fewer than two shared items', () => {
    const rows = compareArms(
      [...itemTrials('only', 'baseline', [true, true, true]), ...itemTrials('only', 'candidate', [true, true, true])],
      'baseline',
      'candidate',
      3,
      ['evaluate']
    );
    expect(rows).toEqual([]);
  });
});
