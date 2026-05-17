import { describe, expect, it } from 'vitest';
import { FLOOR_DIMENSION_NAMES, FLOOR_DIMENSIONS } from '@src/integration/ai/evaluation/_engine/floor-dimensions.ts';

describe('FLOOR_DIMENSIONS', () => {
  it('lists exactly four dimensions in canonical order', () => {
    expect(FLOOR_DIMENSIONS.map((d) => d.name)).toEqual(['Correctness', 'Completeness', 'Safety', 'Consistency']);
  });

  it('every dimension has a non-empty description', () => {
    for (const d of FLOOR_DIMENSIONS) {
      expect(d.description.length).toBeGreaterThan(40);
    }
  });

  it('FLOOR_DIMENSION_NAMES contains lowercased names matching FLOOR_DIMENSIONS', () => {
    expect([...FLOOR_DIMENSION_NAMES].sort()).toEqual(['completeness', 'consistency', 'correctness', 'safety']);
  });
});
