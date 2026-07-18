import { describe, expect, it } from 'vitest';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import {
  chipFlowsFor,
  flowChipVisual,
  SKILL_MOUNTING_FLOW_IDS,
  statusVisual,
} from '@src/application/ui/tui/views/skills-view-internals/flow-visual.ts';

/**
 * Every real `FlowId` mounts skills now (create-pr included — see `flowMountsSkills`), so
 * `SKILL_MOUNTING_FLOW_IDS` is currently the full `FlowId` set. The "non-mounting flow" branches
 * in `flowChipVisual` / `chipFlowsFor` stay defensively coded for a future flow that ships
 * without skill-mounting support; this synthetic id exercises that branch since no real `FlowId`
 * can anymore.
 */
const NON_MOUNTING_FLOW = 'legacy-flow' as unknown as FlowId;

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

  it('reports "broken (no SKILL.md)" for a folder the copy left half-written', () => {
    const e = entry({ installs: [{ flow: 'plan', status: 'broken' }] });
    const v = flowChipVisual('plan', e);
    expect(v.label).toBe('broken (no SKILL.md)');
    expect(v.color).toBe(inkColors.error);
  });

  it('demotes "always on (default)" to "default, off (saved)" under a durable opt-out', () => {
    const e = entry({ name: 'ralphctl-example', defaultFor: ['implement'] });
    const saved = (): ReadonlySet<string> => new Set(['ralphctl-example']);
    const v = flowChipVisual('implement', e, saved);
    expect(v.label).toBe('default, off (saved)');
    expect(v.bold).toBe(false);
  });

  it('renders a non-mounting flow as inactive even when default-on in the registry', () => {
    const e = entry({ defaultFor: [NON_MOUNTING_FLOW] });
    expect(flowChipVisual(NON_MOUNTING_FLOW, e).label).toBe('inactive (flow loads no skills)');
  });
});

describe('SKILL_MOUNTING_FLOW_IDS / chipFlowsFor', () => {
  it('includes createPr — the create-pr view / CLI mount a composed skill source directly', () => {
    expect(SKILL_MOUNTING_FLOW_IDS).toContain('createPr');
    expect(SKILL_MOUNTING_FLOW_IDS).toContain('implement');
  });

  it('chips cover the mounting flows, plus a leftover install on a non-mounting flow', () => {
    expect(chipFlowsFor(entry())).toEqual([...SKILL_MOUNTING_FLOW_IDS]);
    const leftover = entry({ installs: [{ flow: NON_MOUNTING_FLOW, status: 'in-sync' }] });
    expect(chipFlowsFor(leftover)).toEqual([...SKILL_MOUNTING_FLOW_IDS, NON_MOUNTING_FLOW]);
  });
});
