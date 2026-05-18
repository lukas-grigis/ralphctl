import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOW_SKILLS, skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';
import { flowRegistry } from '@src/application/registry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ROOT = join(HERE, '../../../../../src/integration/ai/skills/bundled');

describe('FLOW_SKILLS', () => {
  it('every flow id in FLOW_SKILLS exists in the orchestration registry', () => {
    const knownFlows = new Set(flowRegistry.map((entry) => entry.manifest.id));
    for (const flowId of Object.keys(FLOW_SKILLS)) {
      expect(knownFlows.has(flowId)).toBe(true);
    }
  });

  it('every skill id referenced has a bundled folder on disk', () => {
    const allSkillIds = new Set<string>();
    for (const ids of Object.values(FLOW_SKILLS)) {
      for (const id of ids) allSkillIds.add(id);
    }
    for (const id of allSkillIds) {
      const path = join(BUNDLED_ROOT, id, 'SKILL.md');
      expect(existsSync(path), `bundled skill missing: ${path}`).toBe(true);
    }
  });
});

describe('skillsForFlow', () => {
  it('returns the configured ids for a known flow', () => {
    const ids = skillsForFlow('refine');
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('ralphctl-alignment');
  });

  it('namespaces every bundled skill id with the ralphctl- prefix', () => {
    const allSkillIds = new Set<string>();
    for (const ids of Object.values(FLOW_SKILLS)) {
      for (const id of ids) allSkillIds.add(id);
    }
    for (const id of allSkillIds) {
      expect(id.startsWith('ralphctl-'), `bundled skill id missing prefix: ${id}`).toBe(true);
    }
  });
});
