/**
 * `FLOW_SKILLS` — code-configured mapping of flow id → bundled skill ids that the flow's AI
 * session should have access to.
 *
 * The list of recognised flow ids comes from the flow registry (`orchestration/registry.ts`).
 * `FlowId` is re-exported from `domain/value/flow-id.ts` so this module, the settings schema,
 * and the launcher all read from one definition — the integration test in
 * `tests/unit/orchestration/skills-registry.test.ts` asserts that every key here exists as a
 * flow in the orchestration registry, and that every skill id referenced has a bundled folder
 * on disk.
 *
 * Order in each list does not matter; adapters install in the order given and that's it.
 *
 * v1 parity: v1's `default/` skills (`alignment`, `abstraction-first`, `iterative-review`)
 * were applied to every phase. We keep the same set on every flow for now; refining
 * per-flow assignments is a follow-up.
 */

import type { FlowId } from '@src/domain/value/flow-id.ts';

export type { FlowId };

/** Skill ids referenced below — must each exist as `src/ai/skills/bundled/<id>/SKILL.md`. */
export const FLOW_SKILLS: Record<FlowId, readonly string[]> = {
  refine: [
    'ralphctl-alignment',
    'ralphctl-iterative-review',
    'ralphctl-abstraction-first',
    'ralphctl-minimal-scaffolding',
  ],
  plan: [
    'ralphctl-alignment',
    'ralphctl-iterative-review',
    'ralphctl-abstraction-first',
    'ralphctl-minimal-scaffolding',
  ],
  implement: [
    'ralphctl-alignment',
    'ralphctl-iterative-review',
    'ralphctl-abstraction-first',
    'ralphctl-minimal-scaffolding',
    'ralphctl-debugging-and-error-recovery',
    'ralphctl-test-driven-development',
    'ralphctl-code-review-and-quality',
    'ralphctl-surgical-simplicity',
  ],
  readiness: [
    'ralphctl-alignment',
    'ralphctl-iterative-review',
    'ralphctl-abstraction-first',
    'ralphctl-minimal-scaffolding',
  ],
  ideate: [
    'ralphctl-alignment',
    'ralphctl-iterative-review',
    'ralphctl-abstraction-first',
    'ralphctl-minimal-scaffolding',
    'ralphctl-surgical-simplicity',
  ],
  // `createPr` is the camelCase FlowId for the kebab-case orchestration flow `create-pr`.
  // The mapping lives in the registry test (and in the launcher's `aiFlowIdFor`). Skills
  // mirror the rest — same default bundle.
  createPr: [
    'ralphctl-alignment',
    'ralphctl-iterative-review',
    'ralphctl-abstraction-first',
    'ralphctl-minimal-scaffolding',
    'ralphctl-code-review-and-quality',
  ],
};

/** Type-safe lookup. Returns the configured skill ids or an empty list. */
export const skillsForFlow = (flowId: FlowId): readonly string[] => FLOW_SKILLS[flowId];
