/**
 * Tests for the cursor-centred row windowing used by PickSprintView. The picker shows a
 * cross-project list that can run to hundreds of rows; rendering the full list violates the
 * `slice-before-map` mandate and degrades Ink reconciliation. `computeListWindow` (the shared
 * windowed-list primitive — see `windowed-list.tsx`) is the pure helper that picks the visible
 * slice; these cases are the characterization of the picker's centring math, now expressed
 * against the shared function rather than a picker-local `computeWindow`.
 */

import { describe, expect, it } from 'vitest';
import { computeListWindow } from '@src/application/ui/tui/components/windowed-list.tsx';

describe('computeListWindow (pick-sprint centring math)', () => {
  it('returns the full list when total <= visible', () => {
    expect(computeListWindow(5, 0, 10)).toEqual({ start: 0, end: 5, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it('centres the cursor in the middle of the window when there is room on both sides', () => {
    const window = computeListWindow(50, 25, 10);
    expect(window.start).toBe(20);
    expect(window.end).toBe(30);
    expect(window.hiddenAbove).toBe(20);
    expect(window.hiddenBelow).toBe(20);
  });

  it('clamps the window to the start when cursor is near the top', () => {
    const window = computeListWindow(50, 0, 10);
    expect(window).toEqual({ start: 0, end: 10, hiddenAbove: 0, hiddenBelow: 40 });
  });

  it('clamps the window to the end when cursor is near the bottom', () => {
    const window = computeListWindow(50, 49, 10);
    expect(window).toEqual({ start: 40, end: 50, hiddenAbove: 40, hiddenBelow: 0 });
  });

  it('handles single-element list with cursor at 0', () => {
    expect(computeListWindow(1, 0, 10)).toEqual({ start: 0, end: 1, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it('handles empty row list', () => {
    expect(computeListWindow(0, 0, 10)).toEqual({ start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it('keeps cursor visible when it would otherwise be clamped off the end', () => {
    // cursor 5, visible 4 → window [3,7). Cursor at index 5 is inside the window.
    const window = computeListWindow(10, 5, 4);
    expect(window.start).toBe(3);
    expect(window.end).toBe(7);
    expect(5).toBeGreaterThanOrEqual(window.start);
    expect(5).toBeLessThan(window.end);
  });
});
