/**
 * `FLOW_SKILLS` — code-configured mapping of flow id → bundled skill ids that the flow's AI
 * session should have access to.
 *
 * The list of recognised flow ids comes from the flow registry (`orchestration/registry.ts`).
 * To keep this module dependency-free for tests, the union is mirrored here as a literal —
 * the integration test in `tests/unit/orchestration/skills-registry.test.ts` asserts that
 * every key here exists as a flow in the orchestration registry, and that every skill id
 * referenced has a bundled folder on disk.
 *
 * Order in each list does not matter; adapters install in the order given and that's it.
 *
 * v1 parity: v1's `default/` skills (`alignment`, `abstraction-first`, `iterative-review`)
 * were applied to every phase. We keep the same set on every flow for now; refining
 * per-flow assignments is a follow-up.
 */

/** Flow ids that opt into bundled skill installation. Subset of the flow-registry ids. */
export type FlowId = 'refine' | 'plan' | 'implement' | 'readiness' | 'ideate';

/** Skill ids referenced below — must each exist as `src/ai/skills/bundled/<id>/SKILL.md`. */
export const FLOW_SKILLS: Record<FlowId, readonly string[]> = {
  refine: ['ralphctl-alignment', 'ralphctl-iterative-review', 'ralphctl-abstraction-first'],
  plan: ['ralphctl-alignment', 'ralphctl-iterative-review', 'ralphctl-abstraction-first'],
  implement: ['ralphctl-alignment', 'ralphctl-iterative-review', 'ralphctl-abstraction-first'],
  readiness: ['ralphctl-alignment', 'ralphctl-iterative-review', 'ralphctl-abstraction-first'],
  ideate: ['ralphctl-alignment', 'ralphctl-iterative-review', 'ralphctl-abstraction-first'],
};

/** Type-safe lookup. Returns the configured skill ids or an empty list. */
export const skillsForFlow = (flowId: FlowId): readonly string[] => FLOW_SKILLS[flowId];
