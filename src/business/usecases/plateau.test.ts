import { describe, expect, it } from 'vitest';
import type { EvaluationParseResult } from '@src/business/ports/output-parser.ts';
import { dimensionsEqual, failedDimensions } from './plateau.ts';

function result(
  dimensions: { dimension: string; status: 'PASS' | 'FAIL'; description?: string }[]
): EvaluationParseResult {
  return {
    status: dimensions.some((d) => d.status === 'FAIL') ? 'failed' : 'passed',
    dimensions: dimensions.map((d) => ({
      dimension: d.dimension,
      status: d.status,
      description: d.description ?? '',
    })),
    rawOutput: 'evaluator output',
  };
}

describe('failedDimensions', () => {
  it('extracts only FAIL dimensions', () => {
    const r = result([
      { dimension: 'Correctness', status: 'FAIL' },
      { dimension: 'Completeness', status: 'PASS' },
      { dimension: 'Safety', status: 'FAIL' },
    ]);
    expect(Array.from(failedDimensions(r)).sort()).toEqual(['correctness', 'safety']);
  });

  it('returns an empty set when nothing failed', () => {
    const r = result([{ dimension: 'Correctness', status: 'PASS' }]);
    expect(failedDimensions(r).size).toBe(0);
  });

  it('normalises case and whitespace', () => {
    const r = result([
      { dimension: '  Correctness  ', status: 'FAIL' },
      { dimension: 'correctness', status: 'FAIL' },
    ]);
    expect(failedDimensions(r).size).toBe(1);
    expect(Array.from(failedDimensions(r))).toEqual(['correctness']);
  });
});

describe('dimensionsEqual', () => {
  it('returns true when the same failed dimensions appear twice (order-insensitive)', () => {
    const a = result([
      { dimension: 'Correctness', status: 'FAIL' },
      { dimension: 'Safety', status: 'FAIL' },
    ]);
    const b = result([
      { dimension: 'Safety', status: 'FAIL' },
      { dimension: 'Correctness', status: 'FAIL' },
    ]);
    expect(dimensionsEqual(a, b)).toBe(true);
  });

  it('returns true across case and whitespace variations', () => {
    const a = result([{ dimension: 'Correctness', status: 'FAIL' }]);
    const b = result([{ dimension: '  correctness ', status: 'FAIL' }]);
    expect(dimensionsEqual(a, b)).toBe(true);
  });

  it('returns false when a dimension was fixed', () => {
    const a = result([
      { dimension: 'Correctness', status: 'FAIL' },
      { dimension: 'Safety', status: 'FAIL' },
    ]);
    const b = result([
      { dimension: 'Correctness', status: 'FAIL' },
      { dimension: 'Safety', status: 'PASS' },
    ]);
    expect(dimensionsEqual(a, b)).toBe(false);
  });

  it('returns false when a new failure appeared', () => {
    const a = result([{ dimension: 'Correctness', status: 'FAIL' }]);
    const b = result([
      { dimension: 'Correctness', status: 'FAIL' },
      { dimension: 'Safety', status: 'FAIL' },
    ]);
    expect(dimensionsEqual(a, b)).toBe(false);
  });

  it('returns false when either side has zero failed dimensions', () => {
    const a = result([{ dimension: 'Correctness', status: 'PASS' }]);
    const b = result([{ dimension: 'Correctness', status: 'FAIL' }]);
    expect(dimensionsEqual(a, b)).toBe(false);
    expect(dimensionsEqual(b, a)).toBe(false);
  });

  it('returns false when both sides have zero failures (no plateau to detect)', () => {
    const a = result([{ dimension: 'Correctness', status: 'PASS' }]);
    const b = result([{ dimension: 'Correctness', status: 'PASS' }]);
    expect(dimensionsEqual(a, b)).toBe(false);
  });

  it('ignores changes to prose descriptions when the dimension names match', () => {
    const a = result([{ dimension: 'Correctness', status: 'FAIL', description: 'missing null check' }]);
    const b = result([{ dimension: 'Correctness', status: 'FAIL', description: 'null dereference in handler' }]);
    expect(dimensionsEqual(a, b)).toBe(true);
  });
});
