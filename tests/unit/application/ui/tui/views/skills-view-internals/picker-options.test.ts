import { describe, expect, it } from 'vitest';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import {
  disableOptions,
  enableOptions,
  enablePreselect,
} from '@src/application/ui/tui/views/skills-view-internals/picker-options.ts';
import { SKILL_MOUNTING_FLOW_IDS } from '@src/application/ui/tui/views/skills-view-internals/flow-visual.ts';

const entry = (over: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({
  name: 'ralphctl-example',
  description: 'an example skill',
  defaultFor: [],
  recommendedFor: [],
  installs: [],
  ...over,
});

describe('enableOptions', () => {
  it('offers exactly the skill-mounting flows, createPr included', () => {
    const options = enableOptions(entry());
    expect(options.map((o) => o.value)).toEqual([...SKILL_MOUNTING_FLOW_IDS]);
    expect(options.some((o) => o.value === 'createPr')).toBe(true);
  });

  it('disables an edit-protected install (locally-modified / manual) with the overwrite hint', () => {
    const options = enableOptions(
      entry({
        installs: [
          { flow: 'plan', status: 'locally-modified' },
          { flow: 'implement', status: 'manual' },
        ],
      })
    );
    const plan = options.find((o) => o.value === 'plan');
    const impl = options.find((o) => o.value === 'implement');
    expect(plan?.disabled).toBe(true);
    expect(plan?.description).toContain('u overwrites');
    expect(impl?.disabled).toBe(true);
  });

  it('enablePreselect keeps only selectable recommendations', () => {
    const preselect = enablePreselect(
      entry({
        // refine is default-on; plan is edit-protected; createPr and implement are free.
        recommendedFor: ['createPr', 'refine', 'plan', 'implement'],
        defaultFor: ['refine'],
        installs: [{ flow: 'plan', status: 'locally-modified' }],
      })
    );
    expect(preselect).toEqual(['createPr', 'implement']);
  });

  it('disables a flow the skill is already default-on for, with an explanatory description', () => {
    const options = enableOptions(entry({ defaultFor: ['implement'] }));
    const impl = options.find((o) => o.value === 'implement');
    expect(impl?.disabled).toBe(true);
    expect(impl?.description).toBe('already default-on');
  });

  it('leaves a non-default flow enabled and surfaces its current status when installed', () => {
    const options = enableOptions(entry({ installs: [{ flow: 'plan', status: 'update-available' }] }));
    const plan = options.find((o) => o.value === 'plan');
    expect(plan?.disabled).toBe(false);
    expect(plan?.description).toBe('update available');
  });

  it('leaves the description unset for a flow with no install and no default', () => {
    const options = enableOptions(entry());
    const refine = options.find((o) => o.value === 'refine');
    expect(refine?.description).toBeUndefined();
  });
});

describe('disableOptions', () => {
  it('offers only the currently-installed flows', () => {
    const options = disableOptions(
      entry({
        installs: [
          { flow: 'plan', status: 'in-sync' },
          { flow: 'implement', status: 'locally-modified' },
        ],
      })
    );
    expect(options.map((o) => o.value)).toEqual(['plan', 'implement']);
    expect(options.map((o) => o.description)).toEqual(['in sync', 'locally modified']);
  });

  it('is empty when the skill has no installs', () => {
    expect(disableOptions(entry())).toEqual([]);
  });
});
