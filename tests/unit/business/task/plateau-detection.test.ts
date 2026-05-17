import { describe, expect, it } from 'vitest';
import type { DimensionScore, EvaluationSignal } from '@src/domain/signal.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import { dimensionsEqual, failedDimensions } from '@src/business/task/plateau-detection.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const dim = (name: string, passed: boolean, score: 1 | 2 | 3 | 4 | 5 = passed ? 5 : 2): DimensionScore => ({
  dimension: name,
  score,
  passed,
  finding: '',
});

const evalFrom = (...dims: DimensionScore[]): EvaluationSignal => ({
  type: 'evaluation',
  status: dims.every((d) => d.passed) ? 'passed' : 'failed',
  dimensions: dims,
  timestamp: NOW,
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
