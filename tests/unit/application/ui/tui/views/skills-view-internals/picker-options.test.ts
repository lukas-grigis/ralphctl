import { describe, expect, it } from 'vitest';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { disableOptions, enableOptions } from '@src/application/ui/tui/views/skills-view-internals/picker-options.ts';

const entry = (over: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry => ({
  name: 'ralphctl-example',
  description: 'an example skill',
  defaultFor: [],
  recommendedFor: [],
  installs: [],
  ...over,
});

describe('enableOptions', () => {
  it('offers all six flows', () => {
    expect(enableOptions(entry())).toHaveLength(6);
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
