import { describe, expect, it } from 'vitest';

import type { EvaluationSignal } from '../../../domain/signals/harness-signal.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { dimensionsEqual, failedDimensions } from './plateau-detection.ts';

const T = '2026-04-29T14:15:22.000Z' as IsoTimestamp;

function evalSignal(
  status: 'passed' | 'failed' | 'malformed',
  dims: { dimension: string; passed: boolean }[]
): EvaluationSignal {
  return {
    type: 'evaluation',
    status,
    dimensions: dims.map((d) => ({ ...d, finding: 'x' })),
    timestamp: T,
  };
}

describe('failedDimensions', () => {
  it('returns the set of failed dimension names, lowercased and trimmed', () => {
    const sig = evalSignal('failed', [
      { dimension: 'Correctness', passed: false },
      { dimension: 'safety ', passed: true },
      { dimension: ' Completeness', passed: false },
    ]);

    expect([...failedDimensions(sig)].sort()).toEqual(['completeness', 'correctness']);
  });

  it('returns an empty set when no dimensions failed', () => {
    const sig = evalSignal('passed', [{ dimension: 'Correctness', passed: true }]);
    expect(failedDimensions(sig).size).toBe(0);
  });
});

describe('dimensionsEqual', () => {
  it('returns true when both signals fail the same dimensions', () => {
    const a = evalSignal('failed', [
      { dimension: 'Correctness', passed: false },
      { dimension: 'Safety', passed: false },
    ]);
    const b = evalSignal('failed', [
      { dimension: 'safety', passed: false },
      { dimension: 'CORRECTNESS', passed: false },
    ]);
    expect(dimensionsEqual(a, b)).toBe(true);
  });

  it('returns false when failed dimensions differ', () => {
    const a = evalSignal('failed', [{ dimension: 'Correctness', passed: false }]);
    const b = evalSignal('failed', [{ dimension: 'Safety', passed: false }]);
    expect(dimensionsEqual(a, b)).toBe(false);
  });

  it('returns false when sizes differ', () => {
    const a = evalSignal('failed', [
      { dimension: 'Correctness', passed: false },
      { dimension: 'Safety', passed: false },
    ]);
    const b = evalSignal('failed', [{ dimension: 'Correctness', passed: false }]);
    expect(dimensionsEqual(a, b)).toBe(false);
  });

  it('returns false when either set is empty (passing rounds are not a plateau)', () => {
    const a = evalSignal('passed', []);
    const b = evalSignal('passed', []);
    expect(dimensionsEqual(a, b)).toBe(false);
  });
});
