import { describe, expect, it } from 'vitest';
import { clipName, fitBreadcrumbRight } from '@src/application/ui/tui/components/breadcrumb-fit.ts';

const CHIP = 8;

describe('fitBreadcrumbRight', () => {
  it('leaves everything alone when it fits', () => {
    expect(fitBreadcrumbRight({ budget: 200, project: 'Proj', sprint: 'Sprint', chipCells: CHIP })).toEqual({
      project: 'Proj',
      sprint: 'Sprint',
      showChip: true,
    });
  });

  it('clips names with an ellipsis before touching the badge', () => {
    const fit = fitBreadcrumbRight({
      budget: 75,
      project: 'Hello Python (demo 36bf2290)',
      sprint: 'ready to plan · 36bf2290',
      chipCells: CHIP,
    });
    expect(fit.showChip).toBe(true);
    expect(fit.project.endsWith('…')).toBe(true);
    expect(fit.sprint?.endsWith('…')).toBe(true);
    const used = 'project: '.length + ' [P]'.length + ' · sprint: '.length + ' [S]'.length + CHIP;
    expect(used + [...fit.project].length + [...(fit.sprint ?? '')].length).toBeLessThanOrEqual(75);
  });

  it('drops the badge only when names would fall below a readable minimum', () => {
    const fit = fitBreadcrumbRight({
      budget: 44,
      project: 'Hello Python (demo 36bf2290)',
      sprint: 'ready to plan · 36bf2290',
      chipCells: CHIP,
    });
    expect(fit.showChip).toBe(false);
    expect([...fit.project].length).toBeGreaterThanOrEqual(6);
  });

  it('clips a single project name to the budget', () => {
    expect(fitBreadcrumbRight({ budget: 30, project: 'x'.repeat(40), sprint: undefined, chipCells: 0 }).project).toBe(
      `${'x'.repeat(16)}…`
    );
  });
});

describe('clipName', () => {
  it('keeps short names and ellipsises long ones to the given width', () => {
    expect(clipName('abc', 5)).toBe('abc');
    expect(clipName('abcdefgh', 5)).toBe('abcd…');
  });
});
