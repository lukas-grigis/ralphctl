import { describe, expect, it } from 'vitest';
import { layoutLocation, type LocationInput } from '@src/application/ui/tui/components/location-layout.ts';

const base = (over: Partial<LocationInput> = {}): LocationInput => ({
  columns: 100,
  wide: false,
  section: 'Sprints',
  trail: [],
  ...over,
});

/** Cells the row spends: margins (2 + 2) + both halves + the gap. */
const rowWidth = (l: ReturnType<typeof layoutLocation>): number =>
  4 + [...l.leftText].length + [...l.rightText].length + (l.rightText.length > 0 ? 2 : 0);

describe('layoutLocation', () => {
  it('shows section, crumb, subtitle and the full right side when there is room', () => {
    const l = layoutLocation(
      base({
        trail: ['ready to implement'],
        subtitle: 'scoped',
        project: 'Hello Python',
        sprint: 'ready',
        status: 'active',
      })
    );
    expect(l.leftText).toBe('▣ Sprints › ready to implement — scoped');
    expect(l.rightText).toBe('Hello Python › ready [ACTIVE]');
    expect(l.chip).toBe('[ACTIVE]');
  });

  it('spells out project / sprint and appends `S switch` from lg', () => {
    const l = layoutLocation(
      base({ columns: 160, wide: true, section: 'Work', project: 'Hello', sprint: 'ready', status: 'active' })
    );
    expect(l.rightText).toBe('project Hello › sprint ready [ACTIVE]   S switch');
  });

  it('drops the subtitle first, then trims the trail from its start', () => {
    const input = base({ columns: 70, trail: ['Project', 'Sprint'], subtitle: 'a long subtitle here', project: 'P' });
    const noSubtitle = layoutLocation({ ...input, columns: 50 });
    expect(noSubtitle.leftText).not.toContain('long subtitle');

    const tight = layoutLocation({ ...input, columns: 24, subtitle: undefined, project: 'Hello Python', sprint: 'S1' });
    expect(tight.leftText.startsWith('▣ … › ')).toBe(true);
    expect(tight.leftText.endsWith('Sprint')).toBe(true);
  });

  it('below lg a drilled-in view keeps its whole trail and sheds the context instead', () => {
    const l = layoutLocation(
      base({
        columns: 80,
        section: 'Sprints',
        trail: ['ready to implement · 36bf2290'],
        project: 'Hello Python (demo 36bf2290)',
        sprint: 'ready to plan · 36bf2290',
        status: 'draft',
      })
    );
    expect(l.leftText).toBe('▣ Sprints › ready to implement · 36bf2290');
    expect(l.rightText).toBe('Hello Python (demo 36bf2290)');
    expect(l.rightText).not.toContain('…');
  });

  it('drops the whole [STATUS] chip before it shortens any name', () => {
    const project = 'P'.repeat(30);
    const sprint = 'ready to implement · 36bf2290';
    for (let columns = 90; columns >= 50; columns--) {
      const l = layoutLocation(base({ columns, trail: ['ready to implement'], project, sprint, status: 'active' }));
      // Never a split chip.
      expect(l.rightText.includes('[') ? l.rightText.includes('[ACTIVE]') : true, `${String(columns)}`).toBe(true);
      if (l.rightText.includes('…')) {
        // A shortened name implies the chip already went.
        expect(l.chip).toBeUndefined();
      }
      expect(rowWidth(l)).toBeLessThanOrEqual(columns);
    }
  });

  it('shortens names with … only as the last resort, and never exceeds the row', () => {
    const l = layoutLocation(
      base({ columns: 40, trail: [], project: 'A very long project name', sprint: 'An equally long sprint name' })
    );
    expect(l.rightText).toContain('…');
    expect(rowWidth(l)).toBeLessThanOrEqual(40);
  });

  it('budgets for a caller-owned node after the left text', () => {
    const l = layoutLocation(
      base({
        columns: 60,
        section: 'Runs',
        trail: ['Implement'],
        subtitle: 'task run',
        leftExtraWidth: 9,
        project: 'Hello',
      })
    );
    expect([...l.leftText].length + 10 + [...l.rightText].length + 2 + 4).toBeLessThanOrEqual(60);
  });
});
