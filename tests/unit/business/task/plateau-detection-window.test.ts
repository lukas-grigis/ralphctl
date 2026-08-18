import { describe, expect, it } from 'vitest';
import { FIXED_NOW } from '@tests/fixtures/domain.ts';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import {
  computePlateauVerdict,
  plateauWindowSize,
  pooledActionCounts,
  type PlateauTurnRecord,
  windowIsHardStall,
} from '@src/business/task/plateau-detection.ts';

/**
 * The bolt-on-facing half of the calibrated plateau predicate: `plateauWindowSize` (the operator's
 * `harness.plateauThreshold` knob, clamped) and `windowIsHardStall` (the SAME net-progress
 * cascade + exemptions `computePlateauVerdict` applies, projected onto a window whose LAST element
 * is the current turn — the shape `ctx.plateauHistory` hands the two in-loop detectors).
 *
 * The load-bearing property is SUBORDINATION: a bolt-on detector may never declare a plateau on a
 * window the calibrated predicate exempted (critique shifted / work product changed) or considered
 * progressing (failure count dropped).
 */

const evaluationFor = (dimensions: readonly string[]): EvaluationSignal => ({
  type: 'evaluation',
  status: 'failed',
  dimensions: dimensions.map((d) => ({ dimension: d, passed: false, finding: 'nope' })),
  timestamp: FIXED_NOW,
});

const rec = (opts: {
  readonly dims: readonly string[];
  readonly critique?: string;
  readonly hash?: string;
  readonly actionCounts?: ReadonlyMap<string, number>;
}): PlateauTurnRecord => ({
  evaluation: evaluationFor(opts.dims),
  ...(opts.critique !== undefined ? { critique: opts.critique } : {}),
  ...(opts.hash !== undefined ? { changedFilesHash: opts.hash } : {}),
  ...(opts.actionCounts !== undefined ? { actionCounts: opts.actionCounts } : {}),
});

const RECYCLED = 'the parser still mishandles the trailing comma case in the tokenizer module';
const SHIFTED = 'timezone conversion drops the daylight-saving offset on southern-hemisphere dates';

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

describe('windowIsHardStall', () => {
  it('is false when the window has not filled to the operator threshold yet', () => {
    const window = [rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' })];
    expect(windowIsHardStall(window, { threshold: 3 })).toBe(false);
  });

  it('is true on identical failures + an unchanged work product + a recycled critique', () => {
    const window = [
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
    ];
    expect(windowIsHardStall(window, { threshold: 3 })).toBe(true);
  });

  it('is false when the critique shifted against every prior turn (exemption 1)', () => {
    const window = [
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: SHIFTED, hash: 'h1' }),
    ];
    expect(windowIsHardStall(window, { threshold: 3 })).toBe(false);
  });

  it('is false when the work-product fingerprint changed (exemption 2)', () => {
    const window = [
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h2' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h3' }),
    ];
    expect(windowIsHardStall(window, { threshold: 3 })).toBe(false);
  });

  it('is false when the failed-dimension count dropped inside the window (real progress)', () => {
    const window = [
      rec({ dims: ['correctness', 'safety'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
    ];
    expect(windowIsHardStall(window, { threshold: 3 })).toBe(false);
  });

  it('is false when the current turn has no failed dimensions at all', () => {
    const window = [
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: [], critique: RECYCLED, hash: 'h1' }),
    ];
    expect(windowIsHardStall(window, { threshold: 3 })).toBe(false);
  });

  it('follows the operator knob — a threshold-5 window needs five stalled turns, a threshold-2 window two', () => {
    const stalled = (n: number): readonly PlateauTurnRecord[] =>
      Array.from({ length: n }, () => rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }));

    expect(windowIsHardStall(stalled(3), { threshold: 5 })).toBe(false);
    expect(windowIsHardStall(stalled(5), { threshold: 5 })).toBe(true);
    expect(windowIsHardStall(stalled(2), { threshold: 2 })).toBe(true);
  });

  it('reads only the tail when the history is longer than the window', () => {
    const window = [
      // Stale head — a shifted critique here must not exempt a window that stalled after it.
      rec({ dims: ['correctness'], critique: SHIFTED, hash: 'h0' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
    ];
    expect(windowIsHardStall(window, { threshold: 2 })).toBe(true);
  });

  /**
   * SUBORDINATION INVARIANT — the whole point of the predicate. A bolt-on detector may only speak
   * on a window the calibrated predicate itself would have called a plateau, so a bolt-on can
   * never pre-empt the operator's `plateauThreshold` knob or override its exemptions.
   */
  it('never reports a hard stall on a window the calibrated predicate did not plateau on', () => {
    const scenarios: ReadonlyArray<readonly PlateauTurnRecord[]> = [
      [rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' })],
      [
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
        rec({ dims: ['correctness'], critique: SHIFTED, hash: 'h1' }),
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      ],
      [
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h2' }),
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h3' }),
      ],
      [
        rec({ dims: ['correctness', 'safety'], critique: RECYCLED, hash: 'h1' }),
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      ],
      [
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
        rec({ dims: ['correctness'], critique: RECYCLED, hash: 'h1' }),
      ],
    ];

    for (const window of scenarios) {
      for (const threshold of [2, 3, 5]) {
        const current = window[window.length - 1];
        if (current === undefined) continue;
        const verdict = computePlateauVerdict(window.slice(0, -1), current, { threshold });
        if (windowIsHardStall(window, { threshold })) {
          expect(verdict.kind, `threshold ${String(threshold)}`).toBe('plateau');
        }
      }
    }
  });
});

describe('pooledActionCounts', () => {
  it('sums each signal kind across the window', () => {
    const window = [
      rec({ dims: ['correctness'], actionCounts: new Map([['change', 2]]) }),
      rec({ dims: ['correctness'], actionCounts: new Map([['change', 1]]) }),
      rec({
        dims: ['correctness'],
        actionCounts: new Map([
          ['change', 3],
          ['note', 1],
        ]),
      }),
    ];

    expect([...pooledActionCounts(window).entries()].sort()).toStrictEqual([
      ['change', 6],
      ['note', 1],
    ]);
  });

  it('ignores records that carry no distribution and returns an empty map for an empty window', () => {
    expect(pooledActionCounts([]).size).toBe(0);
    expect([...pooledActionCounts([rec({ dims: ['correctness'] })]).entries()]).toStrictEqual([]);
  });

  /**
   * The K=1 false positive the single-turn detector shipped with: one turn emitting only `change`
   * signals scores H=0. Pooling across the window is what makes an alternating generator (change
   * one turn, note the next) score high instead of collapsing.
   */
  it('pools alternating single-kind turns into a multi-kind distribution', () => {
    const window = [
      rec({ dims: ['correctness'], actionCounts: new Map([['change', 3]]) }),
      rec({ dims: ['correctness'], actionCounts: new Map([['note', 3]]) }),
      rec({ dims: ['correctness'], actionCounts: new Map([['decision', 3]]) }),
    ];
    expect(pooledActionCounts(window).size).toBe(3);
  });
});
