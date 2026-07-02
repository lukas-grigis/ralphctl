import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILLS, skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';
import { flowRegistry } from '@src/application/registry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ROOT = join(HERE, '../../../../../src/integration/ai/skills/bundled');

/**
 * Map a camelCase {@link FlowId} (used in `settings.ai.<flow>` and the skill registry) to the
 * kebab-case orchestration id. Most ids round-trip identically; `createPr` ↔ `create-pr`
 * is the one entry that diverges, mirroring the launcher's `aiFlowIdFor` mapping.
 */
const flowIdToRegistryId = (flowId: string): string => (flowId === 'createPr' ? 'create-pr' : flowId);

/** Every flow referenced across both columns of the table. */
const referencedFlowIds = new Set(BUNDLED_SKILLS.flatMap((entry) => [...entry.defaultFor, ...entry.recommendedFor]));

/** Every skill name referenced across both columns of the table. */
const referencedSkillNames = new Set(BUNDLED_SKILLS.map((entry) => entry.name));

describe('BUNDLED_SKILLS', () => {
  it('every flow id referenced (defaultFor or recommendedFor) exists in the orchestration registry', () => {
    const knownFlows = new Set(flowRegistry.map((entry) => entry.manifest.id));
    for (const flowId of referencedFlowIds) {
      expect(knownFlows.has(flowIdToRegistryId(flowId)), `unknown flow id: ${flowId}`).toBe(true);
    }
  });

  it('every skill name referenced (defaultFor or recommendedFor) has a bundled folder on disk', () => {
    for (const name of referencedSkillNames) {
      const path = join(BUNDLED_ROOT, name, 'SKILL.md');
      expect(existsSync(path), `bundled skill missing: ${path}`).toBe(true);
    }
  });

  it('namespaces every bundled skill name with the ralphctl- prefix', () => {
    for (const name of referencedSkillNames) {
      expect(name.startsWith('ralphctl-'), `bundled skill name missing prefix: ${name}`).toBe(true);
    }
  });

  it('has exactly one entry per skill name', () => {
    expect(referencedSkillNames.size).toBe(BUNDLED_SKILLS.length);
  });
});

describe('skillsForFlow', () => {
  it('returns the default skill names for a known flow', () => {
    const names = skillsForFlow('refine');
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('ralphctl-alignment');
  });

  it('derives its result from defaultFor only (recommendedFor never loads)', () => {
    // `ralphctl-surgical-simplicity` is recommendedFor `refine` but NOT defaultFor it.
    expect(skillsForFlow('refine')).not.toContain('ralphctl-surgical-simplicity');
    expect(skillsForFlow('implement')).toContain('ralphctl-surgical-simplicity');
  });

  it('returns names in table order', () => {
    const names = skillsForFlow('implement');
    const tableOrder = BUNDLED_SKILLS.filter((entry) => entry.defaultFor.includes('implement')).map(
      (entry) => entry.name
    );
    expect(names).toEqual(tableOrder);
  });
});
