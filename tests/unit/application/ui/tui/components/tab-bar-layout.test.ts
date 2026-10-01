import { describe, expect, it } from 'vitest';
import { layoutTabs, type TabLayoutInput } from '@src/application/ui/tui/components/tab-bar-layout.ts';

const base = (over: Partial<TabLayoutInput> = {}): TabLayoutInput => ({
  columns: 100,
  active: 'work',
  badges: { runsLive: 0, doctorWarn: 0, doctorFail: 0 },
  version: '0.25.0',
  ...over,
});

const WIDTHS = [80, 100, 140, 160, 200] as const;
const LABELS = ['1 Work', '2 Sprints', '3 Projects', '4 Runs', '5 System'] as const;

describe('layoutTabs', () => {
  it.each(WIDTHS)('fits %i columns and keeps all five labels whole', (columns) => {
    const { text, width } = layoutTabs(
      base({ columns, badges: { runsLive: 12, doctorWarn: 3, doctorFail: 0 }, latest: '0.26.0' })
    );
    expect(width).toBeLessThanOrEqual(columns);
    expect([...text].length).toBe(width);
    for (const label of LABELS) expect(text).toContain(label);
  });

  it.each(WIDTHS)('wraps only the active tab in [ ] at %i columns', (columns) => {
    const { text } = layoutTabs(base({ columns, active: 'sprints' }));
    expect(text).toContain('[2 Sprints]');
    expect(text.match(/\[/g)).toHaveLength(1);
    expect(text.match(/\]/g)).toHaveLength(1);
  });

  it('brackets the active tab together with its badge', () => {
    const { text } = layoutTabs(base({ active: 'system', badges: { runsLive: 0, doctorWarn: 1, doctorFail: 0 } }));
    expect(text).toContain('[5 System ✚1]');
  });

  it('puts `ralphctl │` first and `? help` flush right with one cell of margin', () => {
    const { text } = layoutTabs(base({ columns: 100 }));
    expect(text.startsWith(' ralphctl │ ')).toBe(true);
    expect(text.endsWith('? help ')).toBe(true);
  });

  describe('badges', () => {
    const badges = { runsLive: 2, doctorWarn: 1, doctorFail: 0 };

    it.each([80, 100, 139] as const)('are compact below lg (%i)', (columns) => {
      const { text } = layoutTabs(base({ columns, badges }));
      expect(text).toContain('4 Runs ●2');
      expect(text).toContain('5 System ✚1');
      expect(text).not.toContain('live');
      expect(text).not.toContain('warning');
    });

    it.each([140, 160, 200] as const)('are verbose from lg (%i)', (columns) => {
      const { text } = layoutTabs(base({ columns, badges }));
      expect(text).toContain('● 2 live');
      expect(text).toContain('✚ 1 warning');
      expect(text).not.toContain('warnings');
    });

    it('pluralises warnings and reports failures as `failing`', () => {
      expect(layoutTabs(base({ columns: 160, badges: { runsLive: 0, doctorWarn: 2, doctorFail: 0 } })).text).toContain(
        '✚ 2 warnings'
      );
      expect(layoutTabs(base({ columns: 160, badges: { runsLive: 0, doctorWarn: 2, doctorFail: 1 } })).text).toContain(
        '✚ 1 failing'
      );
    });

    it('hides both badges when there is nothing to report', () => {
      const { text } = layoutTabs(base({ columns: 160 }));
      expect(text).not.toContain('●');
      expect(text).not.toContain('✚');
    });

    it('tones the system badge by severity', () => {
      const segs = (doctorFail: number): string[] =>
        layoutTabs(base({ badges: { runsLive: 0, doctorWarn: 1, doctorFail } })).segments.map((s) => s.tone);
      expect(segs(0)).toContain('warn');
      expect(segs(1)).toContain('fail');
      expect(segs(1)).not.toContain('warn');
    });
  });

  describe('right side', () => {
    it('is `? help` below lg', () => {
      const { text } = layoutTabs(base({ columns: 139, latest: '0.26.0' }));
      expect(text).toContain('? help');
      expect(text).not.toContain('v0.25.0');
    });

    it('adds the version from lg, and the update when one exists', () => {
      expect(layoutTabs(base({ columns: 160 })).text).toContain('? help · v0.25.0');
      expect(layoutTabs(base({ columns: 160, latest: '0.26.0' })).text).toContain('↑ v0.26.0');
    });
  });

  it('degrades without ever splitting a label on a very narrow terminal', () => {
    const { text, width } = layoutTabs(base({ columns: 60, badges: { runsLive: 12, doctorWarn: 3, doctorFail: 0 } }));
    expect(width).toBeLessThanOrEqual(60);
    for (const label of LABELS) expect(text).toContain(label);
  });
});
