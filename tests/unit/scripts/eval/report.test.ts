import { describe, expect, it } from 'vitest';
import { renderSummary } from '../../../../scripts/eval/report.ts';
import type { ResultsFile } from '../../../../scripts/eval/types.ts';
import { itemTrials, trial } from '../../../fixtures/eval-trials.ts';

const ARM = { name: 'baseline', label: 'claude-economic', rows: {} } as unknown as ResultsFile['arms'][number];

const results = (over: Partial<ResultsFile> = {}): ResultsFile => ({
  schemaVersion: 1,
  runId: 'run-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:10:00.000Z',
  stoppedReason: 'completed',
  gitSha: 'abcdef0123456789',
  gitDirty: false,
  k: 3,
  fixtureSetHash: '0123456789abcdef',
  dryRun: false,
  arms: [ARM],
  budget: {
    maxTokens: 100_000,
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    unmeteredTrials: 0,
    wallMs: 5000,
  },
  trials: [],
  metrics: {},
  usage: {},
  incompleteItems: [],
  notes: [],
  ...over,
});

describe('renderSummary', () => {
  it('prints a per-flow table with mean, CI and n', () => {
    const md = renderSummary(
      results({
        metrics: {
          evaluate: {
            baseline: [{ name: 'catch-rate', n: 40, mean: 0.75, se: 0.05, ci: [0.652, 0.848], approx: false }],
          },
        },
      })
    );
    expect(md).toContain('## evaluate');
    expect(md).toContain('| catch-rate | baseline | 75.0% | [65.2%, 84.8%] | 40 |');
  });

  it('marks an approximate interval and prints the degenerate case instead of a zero-width CI', () => {
    const md = renderSummary(
      results({
        metrics: {
          evaluate: {
            baseline: [
              { name: 'a', n: 10, mean: 0.6, se: 0.15, ci: [0.3, 0.9], approx: true },
              { name: 'b', n: 10, mean: 1, se: 0, ci: null, approx: true },
              { name: 'c', n: 1, mean: 1, se: null, ci: null, approx: true },
            ],
          },
        },
      })
    );
    expect(md).toContain('[30.0%, 90.0%] (approx)');
    expect(md).toContain('all 10 at 100.0% — CLT CI degenerate');
    expect(md).toContain('n/a (fewer than 2 items)');
  });

  it('banners a dry run so nobody reads its numbers as a measurement', () => {
    expect(renderSummary(results({ dryRun: true }))).toContain('DRY RUN');
    expect(renderSummary(results())).not.toContain('DRY RUN');
  });

  it('prints the budget line, stop reason and git state', () => {
    const md = renderSummary(results({ stoppedReason: 'budget', gitDirty: true }));
    expect(md).toContain('stopped: **budget**');
    expect(md).toContain('1500 / 100000 tokens');
    expect(md).toContain('(dirty)');
  });

  it('shows in, cache read, cache write and out separately', () => {
    const md = renderSummary(
      results({
        budget: {
          maxTokens: 100_000,
          inputTokens: 100,
          outputTokens: 300,
          cacheReadTokens: 5000,
          cacheCreationTokens: 600,
          unmeteredTrials: 0,
          wallMs: 5000,
        },
        metrics: {
          evaluate: { baseline: [{ name: 'correct', n: 4, mean: 0.5, se: 0.2, ci: [0.1, 0.9], approx: true }] },
        },
        usage: {
          evaluate: {
            baseline: {
              trials: 2,
              inputTokens: 100,
              outputTokens: 300,
              cacheReadTokens: 5000,
              cacheCreationTokens: 600,
              meanInputTokens: 50,
              meanOutputTokens: 150,
              meanCacheReadTokens: 2500,
              meanCacheCreationTokens: 300,
              wallMs: 2000,
              meanWallMs: 1000,
              unmeteredTrials: 0,
            },
          },
        },
      })
    );
    expect(md).toContain('6000 / 100000 tokens');
    expect(md).toContain('cache read 5000');
    expect(md).toContain('cache write 600');
    expect(md).toContain('in 100');
    expect(md).toContain('out 300');
  });

  it('prints n/a for token counts that were never reported', () => {
    const md = renderSummary(
      results({
        metrics: {
          evaluate: { baseline: [{ name: 'correct', n: 4, mean: 0.5, se: 0.2, ci: [0.1, 0.9], approx: true }] },
        },
        usage: {
          evaluate: {
            baseline: {
              trials: 4,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              meanInputTokens: null,
              meanOutputTokens: null,
              meanCacheReadTokens: null,
              meanCacheCreationTokens: null,
              wallMs: 4000,
              meanWallMs: 1000,
              unmeteredTrials: 4,
            },
          },
        },
      })
    );
    expect(md).toContain('in n/a');
    expect(md).toContain('4 unmetered');
  });

  it('prints the comparison with delta, CI, verdict and MDE', () => {
    const md = renderSummary(
      results({
        comparison: [
          {
            flow: 'evaluate',
            metric: 'correct',
            n: 12,
            meanDiff: 0.1,
            se: 0.04,
            ci: [0.02, 0.18],
            detectable: true,
            approx: false,
            mde: 0.12,
          },
          {
            flow: 'evaluate',
            metric: 'catch-rate',
            n: 6,
            meanDiff: -0.05,
            se: 0.1,
            ci: [-0.25, 0.15],
            detectable: false,
            approx: true,
            mde: 0.3,
          },
        ],
      })
    );
    expect(md).toContain(
      '| evaluate | correct | +10.0 pp | [+2.0 pp, +18.0 pp] | detectable difference | ±12.0% | 12 |'
    );
    expect(md).toContain(
      '| evaluate | catch-rate | -5.0 pp | [-25.0 pp, +15.0 pp] (approx) | no detectable difference at this N | ±30.0% | 6 |'
    );
  });

  it('lists incomplete items, saturation candidates and the k-sufficiency line', () => {
    const md = renderSummary(
      results({
        metrics: { evaluate: { baseline: [] } },
        incompleteItems: ['baseline:ev-9/defect'],
        trials: [
          ...itemTrials('cap-1', 'baseline', [true, true, true], { tier: 'capability' }),
          ...itemTrials('cap-2', 'baseline', [true, false, true], { tier: 'capability' }),
        ],
      })
    );
    expect(md).toContain('## Incomplete items');
    expect(md).toContain('baseline:ev-9/defect');
    expect(md).toContain('baseline: cap-1/defect');
    expect(md).not.toContain('baseline: cap-2/defect');
    expect(md).toContain('mean(σ²_i)/K');
  });

  it('links the artifact directory of every incorrect trial', () => {
    const md = renderSummary(
      results({
        trials: [
          trial({ correct: false, artifactDir: 'trials/fx-1/defect/baseline/2', trialIndex: 2 }),
          trial({
            correct: false,
            graded: false,
            error: 'spawn failed',
            artifactDir: 'trials/fx-1/defect/baseline/3',
            trialIndex: 3,
          }),
          trial({ correct: true, artifactDir: 'trials/fx-1/defect/baseline/1' }),
        ],
      })
    );
    expect(md).toContain('`trials/fx-1/defect/baseline/2`');
    expect(md).toContain('(ungraded: spawn failed) → `trials/fx-1/defect/baseline/3`');
    expect(md).not.toContain('baseline/1`');
  });
});
