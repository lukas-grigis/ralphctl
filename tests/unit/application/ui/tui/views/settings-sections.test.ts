import { describe, expect, it } from 'vitest';
import { fitSectionTabs } from '@src/application/ui/tui/views/settings-sections.tsx';

const LABELS = ['Presets', 'Global', 'Refine', 'Plan', 'Implement', 'Readiness', 'Ideate', 'Create-PR', 'Harness'];

describe('fitSectionTabs', () => {
  it('shows every tab when they all fit', () => {
    expect(fitSectionTabs(LABELS, 0, 200)).toEqual({ start: 0, end: LABELS.length });
  });

  it('always holds the active tab and never exceeds the width, whichever tab is active', () => {
    for (const width of [40, 60, 76]) {
      for (let active = 0; active < LABELS.length; active++) {
        const { start, end } = fitSectionTabs(LABELS, active, width);
        expect(start).toBeLessThanOrEqual(active);
        expect(end).toBeGreaterThan(active);
        const tabs = LABELS.slice(start, end).reduce((n, l, i) => n + l.length + 2 + (i > 0 ? 2 : 0), 0);
        const cues = (start > 0 ? 2 : 0) + (end < LABELS.length ? 2 : 0);
        expect(tabs + cues).toBeLessThanOrEqual(width);
      }
    }
  });
});
