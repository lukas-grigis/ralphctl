import { describe, expect, it } from 'vitest';
import type { DimensionScore, EvaluationSignal } from '@src/domain/signal.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import {
  computePlateauVerdict,
  dimensionsEqual,
  failedDimensions,
  type PlateauTurnRecord,
  trigramJaccard,
} from '@src/business/task/plateau-detection.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const dim = (name: string, passed: boolean): DimensionScore => ({
  dimension: name,
  passed,
  finding: passed ? '' : 'placeholder failure finding',
});

const evalFrom = (...dims: DimensionScore[]): EvaluationSignal => ({
  type: 'evaluation',
  status: dims.every((d) => d.passed) ? 'passed' : 'failed',
  dimensions: dims,
  timestamp: NOW,
});

const turn = (ev: EvaluationSignal, extras?: { critique?: string; commitSubject?: string }): PlateauTurnRecord => ({
  evaluation: ev,
  ...(extras?.critique !== undefined ? { critique: extras.critique } : {}),
  ...(extras?.commitSubject !== undefined ? { commitSubject: extras.commitSubject } : {}),
});

describe('failedDimensions', () => {
  it('returns empty set when nothing failed', () => {
    expect(failedDimensions(evalFrom(dim('correctness', true)))).toEqual(new Set());
  });

  it('returns lowercased trimmed names of failed dimensions only', () => {
    const sig = evalFrom(dim(' Correctness ', false), dim('Completeness', true), dim('SAFETY', false));
    expect(failedDimensions(sig)).toEqual(new Set(['correctness', 'safety']));
  });
});

describe('dimensionsEqual', () => {
  it("false when both sets empty (no failures couldn't have caused a plateau)", () => {
    expect(dimensionsEqual(evalFrom(dim('a', true)), evalFrom(dim('a', true)))).toBe(false);
  });

  it('false when one side empty', () => {
    const failed = evalFrom(dim('a', false));
    const passed = evalFrom(dim('a', true));
    expect(dimensionsEqual(failed, passed)).toBe(false);
    expect(dimensionsEqual(passed, failed)).toBe(false);
  });

  it('false when sets are disjoint', () => {
    expect(dimensionsEqual(evalFrom(dim('a', false)), evalFrom(dim('b', false)))).toBe(false);
  });

  it('false when sets are not equal in size', () => {
    expect(dimensionsEqual(evalFrom(dim('a', false)), evalFrom(dim('a', false), dim('b', false)))).toBe(false);
  });

  it('true when sets match exactly', () => {
    expect(
      dimensionsEqual(evalFrom(dim('a', false), dim('b', false)), evalFrom(dim('a', false), dim('b', false)))
    ).toBe(true);
  });

  it('case-insensitive and whitespace-insensitive comparison', () => {
    expect(dimensionsEqual(evalFrom(dim('Correctness', false)), evalFrom(dim(' correctness ', false)))).toBe(true);
  });
});

describe('trigramJaccard', () => {
  it('returns 1 for identical strings', () => {
    expect(trigramJaccard('hello world', 'hello world')).toBe(1);
  });

  it('returns 1 for two empty strings', () => {
    expect(trigramJaccard('', '')).toBe(1);
  });

  it('returns a small value for disjoint strings', () => {
    expect(trigramJaccard('alpha beta gamma', 'XYZ QRS TUV')).toBeLessThan(0.1);
  });

  it('produces ≥ 0.5 for tiny tweaks', () => {
    const a = 'still missing the early-return branch in the parser';
    const b = 'still missing the early-return branch in the parser.';
    expect(trigramJaccard(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  it('produces < 0.5 for materially different prose', () => {
    const a = 'still missing the early-return branch in the parser';
    const b = 'overflow on huge inputs; bounds check needed in the buffer alloc path';
    expect(trigramJaccard(a, b)).toBeLessThan(0.5);
  });
});

describe('computePlateauVerdict — base case (regression for 2026-05-20 verified path)', () => {
  it('fires when dimensions repeat identically across the default threshold of 2 turns', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev), { threshold: 2 });
    expect(verdict.kind).toBe('plateau');
    if (verdict.kind === 'plateau') expect(verdict.dimensions).toEqual(['completeness']);
  });

  it('does not fire on a single turn (not enough history)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([], turn(ev), { threshold: 2 });
    expect(verdict.kind).toBe('none');
  });

  it('does not fire when failed dimensions differ between turns', () => {
    const prior = evalFrom(dim('correctness', false));
    const current = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(prior)], turn(current), { threshold: 2 });
    expect(verdict.kind).toBe('none');
  });

  it('does not fire when current turn has no failed dimensions', () => {
    const prior = evalFrom(dim('completeness', false));
    const current = evalFrom(dim('completeness', true));
    const verdict = computePlateauVerdict([turn(prior)], turn(current), { threshold: 2 });
    expect(verdict.kind).toBe('none');
  });
});

describe('computePlateauVerdict — commit-progress softening', () => {
  it('returns "warning" when same dims+scores but commit subject changed', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { commitSubject: 'WIP option A' })],
      turn(ev, { commitSubject: 'WIP option B' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('warning');
    if (verdict.kind === 'warning') {
      expect(verdict.dimensions).toEqual(['completeness']);
      expect(verdict.reason).toBe('commit-progress');
    }
  });

  it('does not soften when commit subject is the same', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { commitSubject: 'same subject' })],
      turn(ev, { commitSubject: 'same subject' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('does not soften when commit subject is missing on one side', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev, { commitSubject: 'first commit' }), {
      threshold: 2,
    });
    expect(verdict.kind).toBe('plateau');
  });
});

describe('computePlateauVerdict — critique-shift exemption', () => {
  it('returns "progress" when critique Jaccard < 0.5', () => {
    const ev = evalFrom(dim('completeness', false));
    const priorCritique = 'still missing the early-return branch in the parser';
    const currentCritique = 'overflow on huge inputs; bounds check needed in the buffer alloc path';
    const verdict = computePlateauVerdict(
      [turn(ev, { critique: priorCritique })],
      turn(ev, { critique: currentCritique }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('progress');
    if (verdict.kind === 'progress') expect(verdict.reason).toBe('critique-shifted');
  });

  it('does not exempt when critique is near-identical (Jaccard ≥ 0.5)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict(
      [turn(ev, { critique: 'still missing the X branch' })],
      turn(ev, { critique: 'still missing the X branch.' }),
      { threshold: 2 }
    );
    expect(verdict.kind).toBe('plateau');
  });

  it('falls through to plateau when critique is missing on either side', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev, { critique: 'only one side has it' }), {
      threshold: 2,
    });
    expect(verdict.kind).toBe('plateau');
  });
});

describe('computePlateauVerdict — configurable threshold', () => {
  it('threshold=3: two consecutive same-dim turns → no plateau yet', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev), { threshold: 3 });
    expect(verdict.kind).toBe('none');
  });

  it('threshold=3: three consecutive same-dim turns → plateau fires', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev), turn(ev)], turn(ev), { threshold: 3 });
    expect(verdict.kind).toBe('plateau');
  });

  it('threshold=5: needs 5 consecutive same-dim turns; 4 prior + current fires', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev), turn(ev), turn(ev), turn(ev)], turn(ev), { threshold: 5 });
    expect(verdict.kind).toBe('plateau');
  });

  it('clamps an out-of-range threshold defensively (0 → 2)', () => {
    const ev = evalFrom(dim('completeness', false));
    const verdict = computePlateauVerdict([turn(ev)], turn(ev), { threshold: 0 });
    expect(verdict.kind).toBe('plateau');
  });

  it('clamps an out-of-range threshold defensively (99 → 5)', () => {
    const ev = evalFrom(dim('completeness', false));
    // Four prior + current = 5 turns total — exactly the clamped maximum.
    const verdict = computePlateauVerdict([turn(ev), turn(ev), turn(ev), turn(ev)], turn(ev), {
      threshold: 99,
    });
    expect(verdict.kind).toBe('plateau');
  });
});

describe('computePlateauVerdict — sliding window', () => {
  it('only looks at the most-recent (threshold-1) prior turns, not the whole history', () => {
    const stable = evalFrom(dim('completeness', false));
    const noise = evalFrom(dim('safety', false));
    // Old noise should not break the window: at threshold=2 we only compare the last prior + current.
    const verdict = computePlateauVerdict([turn(noise), turn(stable)], turn(stable), { threshold: 2 });
    expect(verdict.kind).toBe('plateau');
  });
});
