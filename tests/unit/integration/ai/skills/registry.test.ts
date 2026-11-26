import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILLS, skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';
import { flowRegistry } from '@src/application/registry.ts';
import { FLOW_IDS } from '@src/domain/value/flow-id.ts';

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
  it('pins the default set of every flow, in table order', () => {
    const expected: Record<(typeof FLOW_IDS)[number], readonly string[]> = {
      refine: [],
      plan: ['ralphctl-ponytail'],
      ideate: ['ralphctl-idea-refinement'],
      implement: [
        'ralphctl-ponytail',
        'ralphctl-code-review-and-quality',
        'ralphctl-security-and-hardening',
        'ralphctl-test-driven-development',
        'ralphctl-debugging-and-error-recovery',
      ],
      readiness: ['ralphctl-writing-for-agents'],
      createPr: [],
    };
    for (const flowId of FLOW_IDS) expect(skillsForFlow(flowId), flowId).toEqual(expected[flowId]);
  });

  it('derives its result from defaultFor only (recommendedFor never loads)', () => {
    // `ralphctl-writing-for-agents` is recommendedFor `plan` but defaultFor readiness only.
    expect(skillsForFlow('plan')).not.toContain('ralphctl-writing-for-agents');
    expect(skillsForFlow('readiness')).toContain('ralphctl-writing-for-agents');
  });

  it('never loads the opt-in-only skills by default in any flow', () => {
    // The reinforcements restate what a prompt already owns; the rest are topic-specific, and
    // every default costs context on every session of its phase.
    const optInOnly = [
      'ralphctl-karpathy-guidelines',
      'ralphctl-spec-driven-development',
      'ralphctl-ambition',
      'ralphctl-humanizer',
      'ralphctl-domain-driven-design',
      'ralphctl-api-and-interface-design',
      'ralphctl-performance-optimization',
      'ralphctl-frontend-ui-engineering',
      'ralphctl-deprecation-and-migration',
      'ralphctl-code-simplification',
      'ralphctl-source-driven-development',
      'ralphctl-observability-and-instrumentation',
      'ralphctl-codebase-design',
    ];
    for (const flowId of FLOW_IDS) {
      for (const name of optInOnly) expect(skillsForFlow(flowId)).not.toContain(name);
    }
  });

  it('returns names in table order', () => {
    const names = skillsForFlow('implement');
    const tableOrder = BUNDLED_SKILLS.filter((entry) => entry.defaultFor.includes('implement')).map(
      (entry) => entry.name
    );
    expect(names).toEqual(tableOrder);
  });
});

describe('ralphctl-ambition placement', () => {
  const ambition = BUNDLED_SKILLS.find((entry) => entry.name === 'ralphctl-ambition');

  it('is registered as opt-in for ideate, refine and plan only', () => {
    expect(ambition?.defaultFor).toEqual([]);
    expect(ambition?.recommendedFor).toEqual(['ideate', 'refine', 'plan']);
  });

  it('is never mounted or suggested in implement or createPr', () => {
    // implement's evaluator shares the generator's skill set and would grade against criteria
    // nobody asked for; createPr is a one-shot extraction with nothing to raise.
    for (const flowId of ['implement', 'createPr'] as const) {
      expect(ambition?.defaultFor).not.toContain(flowId);
      expect(ambition?.recommendedFor).not.toContain(flowId);
    }
  });
});

describe('retired bundled skills', () => {
  it('stay out of the table', () => {
    const retired = [
      'ralphctl-alignment',
      'ralphctl-iterative-review',
      'ralphctl-abstraction-first',
      'ralphctl-minimal-scaffolding',
      'ralphctl-cherny-workflow',
      'ralphctl-surgical-simplicity',
    ];
    for (const name of retired) expect(referencedSkillNames.has(name), name).toBe(false);
  });
});
