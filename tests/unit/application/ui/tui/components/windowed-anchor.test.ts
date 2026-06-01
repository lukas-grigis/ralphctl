import { describe, expect, it } from 'vitest';
import { computeAnchoredWindow } from '@src/application/ui/tui/components/windowed-anchor.ts';

describe('computeAnchoredWindow', () => {
  it('returns the full range with nothing hidden when the list fits the budget', () => {
    expect(computeAnchoredWindow(3, 0, 5)).toEqual({ start: 0, end: 3, hiddenBefore: 0, hiddenAfter: 0 });
    expect(computeAnchoredWindow(5, 2, 5)).toEqual({ start: 0, end: 5, hiddenBefore: 0, hiddenAfter: 0 });
  });

  it('treats a non-positive budget as unbounded (no windowing)', () => {
    expect(computeAnchoredWindow(10, 4, 0)).toEqual({ start: 0, end: 10, hiddenBefore: 0, hiddenAfter: 0 });
  });

  it('handles an empty list', () => {
    expect(computeAnchoredWindow(0, 0, 4)).toEqual({ start: 0, end: 0, hiddenBefore: 0, hiddenAfter: 0 });
    expect(computeAnchoredWindow(0, -1, 4)).toEqual({ start: 0, end: 0, hiddenBefore: 0, hiddenAfter: 0 });
  });

  it('centres the window on the anchor and reports both hidden counts', () => {
    // 10 items, budget 4, anchor 5 → half=2 → start=3, end=7.
    expect(computeAnchoredWindow(10, 5, 4)).toEqual({ start: 3, end: 7, hiddenBefore: 3, hiddenAfter: 3 });
  });

  it('clamps the window to the start edge when the anchor is near the head', () => {
    // anchor 0 → start clamps to 0, window [0,4).
    expect(computeAnchoredWindow(10, 0, 4)).toEqual({ start: 0, end: 4, hiddenBefore: 0, hiddenAfter: 6 });
  });

  it('clamps the window to the end edge (full last page, not a short tail)', () => {
    // anchor 9 (last) → start clamps to total-cap=6, window [6,10).
    expect(computeAnchoredWindow(10, 9, 4)).toEqual({ start: 6, end: 10, hiddenBefore: 6, hiddenAfter: 0 });
  });

  it('always keeps the anchor inside the returned window', () => {
    const total = 25;
    const cap = 6;
    for (let anchor = 0; anchor < total; anchor++) {
      const w = computeAnchoredWindow(total, anchor, cap);
      expect(anchor).toBeGreaterThanOrEqual(w.start);
      expect(anchor).toBeLessThan(w.end);
      expect(w.end - w.start).toBe(cap);
      expect(w.hiddenBefore + (w.end - w.start) + w.hiddenAfter).toBe(total);
    }
  });

  it('clamps a stale / out-of-range anchor into the list', () => {
    expect(computeAnchoredWindow(10, 999, 4)).toEqual({ start: 6, end: 10, hiddenBefore: 6, hiddenAfter: 0 });
    expect(computeAnchoredWindow(10, -5, 4)).toEqual({ start: 0, end: 4, hiddenBefore: 0, hiddenAfter: 6 });
  });
});
