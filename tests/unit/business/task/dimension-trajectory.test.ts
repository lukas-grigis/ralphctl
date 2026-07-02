import { describe, expect, it } from 'vitest';
import type { EvaluationSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
import { composeDimensionTrajectory } from '@src/business/task/dimension-trajectory.ts';

const TS = '2026-06-12T00:00:00.000Z' as IsoTimestamp;

const evalWith = (
  failed: readonly string[],
  passed: readonly string[] = [],
  notApplicable: readonly string[] = []
): EvaluationSignal => ({
  type: 'evaluation',
  status: failed.length === 0 ? 'passed' : 'failed',
  dimensions: [
    ...failed.map((d) => ({ dimension: d, passed: false, finding: 'x' })),
    ...passed.map((d) => ({ dimension: d, passed: true, finding: 'ok' })),
    ...notApplicable.map((d) => ({ dimension: d, passed: false, applicable: false, finding: 'not applicable' })),
  ],
  timestamp: TS,
});

const turn = (
  failed: readonly string[],
  passed: readonly string[] = [],
  notApplicable: readonly string[] = []
): PlateauTurnRecord => ({
  evaluation: evalWith(failed, passed, notApplicable),
});

describe('composeDimensionTrajectory', () => {
  it('returns empty when fewer than two turns are recorded (nothing to diff)', () => {
    expect(composeDimensionTrajectory({ history: [], plateauThreshold: 3, roundNum: 1, maxTurns: 5 })).toBe('');
    expect(
      composeDimensionTrajectory({ history: [turn(['correctness'])], plateauThreshold: 3, roundNum: 2, maxTurns: 5 })
    ).toBe('');
  });

  it('reports a dimension fixed since the prior round', () => {
    const out = composeDimensionTrajectory({
      history: [turn(['safety', 'correctness']), turn(['correctness'], ['safety'])],
      plateauThreshold: 3,
      roundNum: 2,
      maxTurns: 5,
    });
    expect(out).toContain('## Dimension trajectory');
    expect(out).toContain('safety: fixed since last round');
  });

  it('reports a still-failing dimension with its consecutive-round count', () => {
    const out = composeDimensionTrajectory({
      history: [turn(['correctness']), turn(['correctness']), turn(['correctness'])],
      plateauThreshold: 5,
      roundNum: 3,
      maxTurns: 8,
    });
    expect(out).toContain('correctness: STILL FAILING (3 consecutive rounds)');
  });

  it('reports a newly failing dimension that did not fail in the prior round', () => {
    const out = composeDimensionTrajectory({
      history: [turn(['correctness']), turn(['correctness', 'completeness'])],
      plateauThreshold: 5,
      roundNum: 2,
      maxTurns: 8,
    });
    expect(out).toContain('completeness: newly failing this round');
  });

  it('treats an applicable:false dimension as never failing, not newly failing', () => {
    const out = composeDimensionTrajectory({
      history: [turn(['correctness']), turn(['correctness'], [], ['robustness'])],
      plateauThreshold: 5,
      roundNum: 2,
      maxTurns: 8,
    });
    expect(out).not.toContain('robustness');
  });

  it('fires the budget-pressure line one round before the plateau threshold', () => {
    // threshold 3 → pressure when the longest still-failing streak reaches 2.
    const out = composeDimensionTrajectory({
      history: [turn(['correctness']), turn(['correctness'])],
      plateauThreshold: 3,
      roundNum: 2,
      maxTurns: 5,
    });
    expect(out).toContain('stalled round(s)');
    expect(out).toContain('exits this loop at 3 consecutive stalled rounds');
    expect(out).toContain('fundamentally different fix');
  });

  it('does NOT fire the pressure line before the threshold-1 stall point', () => {
    // threshold 5, streak only 2 → no pressure yet.
    const out = composeDimensionTrajectory({
      history: [turn(['correctness']), turn(['correctness'])],
      plateauThreshold: 5,
      roundNum: 2,
      maxTurns: 8,
    });
    expect(out).toContain('STILL FAILING');
    expect(out).not.toContain('stalled round(s)');
  });

  it('is deterministic — identical history renders an identical block', () => {
    const history = [turn(['safety', 'correctness']), turn(['correctness'], ['safety'])];
    const a = composeDimensionTrajectory({ history, plateauThreshold: 3, roundNum: 2, maxTurns: 5 });
    const b = composeDimensionTrajectory({ history, plateauThreshold: 3, roundNum: 2, maxTurns: 5 });
    expect(a).toBe(b);
  });
});
