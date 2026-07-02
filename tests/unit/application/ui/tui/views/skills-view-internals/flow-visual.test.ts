import { describe, expect, it } from 'vitest';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { flowChipVisual, statusVisual } from '@src/application/ui/tui/views/skills-view-internals/flow-visual.ts';

const entry = (over: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({
  name: 'ralphctl-example',
  description: 'an example skill',
  defaultFor: [],
  recommendedFor: [],
  installs: [],
  ...over,
});

describe('statusVisual', () => {
  it('maps every SkillInstallStatus to a distinct glyph', () => {
    const statuses = ['in-sync', 'update-available', 'locally-modified', 'manual'] as const;
    const glyphsSeen = statuses.map((s) => statusVisual(s).glyph);
    expect(new Set(glyphsSeen).size).toBe(statuses.length);
  });

  it('locally-modified uses the dedicated `modified` glyph in error color', () => {
    const v = statusVisual('locally-modified');
    expect(v.glyph).toBe(glyphs.modified);
    expect(v.color).toBe(inkColors.error);
  });

  it('update-available uses the warning glyph in warning color', () => {
    const v = statusVisual('update-available');
    expect(v.glyph).toBe(glyphs.warningGlyph);
    expect(v.color).toBe(inkColors.warning);
  });
});

describe('flowChipVisual', () => {
  it('reports "always on (default)" for a defaultFor flow, ignoring any install status', () => {
    const e = entry({ defaultFor: ['implement'], installs: [{ flow: 'implement', status: 'locally-modified' }] });
    const v = flowChipVisual('implement', e);
    expect(v.label).toBe('always on (default)');
    expect(v.glyph).toBe(glyphs.phaseDone);
    expect(v.bold).toBe(true);
  });

  it('reports "not enabled" when the flow has no install and is not default-on', () => {
    const v = flowChipVisual('plan', entry());
    expect(v.label).toBe('not enabled');
    expect(v.glyph).toBe(glyphs.phaseDisabled);
  });

  it('delegates to statusVisual when an install exists and the flow is not default-on', () => {
    const e = entry({ installs: [{ flow: 'refine', status: 'in-sync' }] });
    expect(flowChipVisual('refine', e)).toEqual(statusVisual('in-sync'));
  });
});
