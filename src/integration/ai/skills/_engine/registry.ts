/**
 * `BUNDLED_SKILLS` — the extensible per-skill registry: one row per bundled skill, each row
 * naming the flows the skill is default-ON for and the flows it is merely *recommended* for.
 * This replaces the old flat `FLOW_SKILLS` (flow → skill ids) mapping; inverting the table so a
 * skill owns its own phase assignments keeps adding / re-curating a skill a one-row edit and
 * lets the opt-in catalog surface per-skill suggestions.
 *
 * Two fields, two distinct jobs:
 *   - `defaultFor`      — phases where the skill is installed automatically (loading behaviour).
 *                         `skillsForFlow` derives its result from this column, so it drives what
 *                         a flow's AI session actually receives.
 *   - `recommendedFor`  — catalog-only opt-in suggestion (display behaviour). It NEVER loads a
 *                         skill; the TUI catalog uses it to nudge "this might help here too".
 *                         May overlap `defaultFor`, but by convention we list only the *extra*
 *                         phases beyond the defaults to keep the two columns readable.
 *
 * Default-set curation: the first eight rows keep the assignments inherited from v1's
 * `FLOW_SKILLS`; the curated additions below them are promoted into the phases where their
 * discipline is strongest (rationale inline per row). Overlap between skills is deliberate —
 * skill bodies are lightweight and the per-run / per-flow opt-out (`settings.ai.skills`,
 * customize-picker skills step) lets an operator trim any of it. `ralphctl-cherny-workflow` is
 * the one curated skill left default-OFF: the harness itself already enforces its core loop
 * (plan gate, check gate, evaluator), so it stays an opt-in reinforcement.
 *
 * `FlowId` is re-exported from `domain/value/flow-id.ts` so this module, the settings schema,
 * the skill sources, and the launcher all read one definition of the flow set. The registry
 * test (`tests/unit/integration/ai/skills/registry.test.ts`) fences two invariants: every
 * `FlowId` referenced in either column exists in the orchestration flow registry, and every
 * skill `name` (again from either column) resolves to a `bundled/<name>/SKILL.md` folder.
 *
 * Table order is the canonical order: `skillsForFlow` returns matching names in the order they
 * appear below, and adapters install in that order.
 */

import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';

export type { FlowId };

/** Every AI flow — skills carried over from v1's global `default/` bundle are default-ON here. */
const ALL_FLOWS = FLOW_IDS;

/**
 * One bundled skill and its phase assignments. `name` must match a `bundled/<name>/SKILL.md`
 * folder (and, per the Agent Skills spec, that file's frontmatter `name`); the `ralphctl-`
 * prefix is required.
 *
 * @public
 */
export interface BundledSkillEntry {
  /** `ralphctl-*` — must match the bundled folder name. */
  readonly name: string;
  /** Phases where the skill is installed by default (loading; drives `skillsForFlow`). */
  readonly defaultFor: readonly FlowId[];
  /** Extra phases the catalog suggests for opt-in (display only; never loads the skill). */
  readonly recommendedFor: readonly FlowId[];
}

/**
 * The bundled-skill catalog. Order is significant — see the module doc comment.
 *
 * @public
 */
export const BUNDLED_SKILLS: readonly BundledSkillEntry[] = [
  // The four skills below descend from v1's global `default/` bundle, so they stay default-ON
  // everywhere; there is no phase left to recommend them for.
  { name: 'ralphctl-alignment', defaultFor: ALL_FLOWS, recommendedFor: [] },
  { name: 'ralphctl-iterative-review', defaultFor: ALL_FLOWS, recommendedFor: [] },
  { name: 'ralphctl-abstraction-first', defaultFor: ALL_FLOWS, recommendedFor: [] },
  { name: 'ralphctl-minimal-scaffolding', defaultFor: ALL_FLOWS, recommendedFor: [] },
  // Implement-centric skills — recommendedFor names conservative adjacent phases where the
  // discipline plausibly earns its place beyond the default set.
  {
    name: 'ralphctl-debugging-and-error-recovery',
    defaultFor: ['implement'],
    recommendedFor: ['readiness'],
  },
  {
    name: 'ralphctl-test-driven-development',
    defaultFor: ['implement'],
    recommendedFor: ['plan', 'readiness'],
  },
  {
    // createPr is recommended opt-in, not default. This skill coaches emitting review-oriented
    // <note> / <decision> signals; create-pr's output contract keeps only the single pr-content
    // signal and DROPS any such narrative signal (generate-pr-content.contract.ts is tolerant by
    // design), so recommending it here is safe. It stays opt-in rather than default because
    // review-signal guidance is only sometimes what you want while authoring a PR body.
    name: 'ralphctl-code-review-and-quality',
    defaultFor: ['implement'],
    recommendedFor: ['readiness', 'createPr'],
  },
  {
    name: 'ralphctl-surgical-simplicity',
    defaultFor: ['implement', 'ideate'],
    recommendedFor: ['refine', 'plan'],
  },
  // Curated catalog additions — promoted into the phases where each discipline is strongest
  // (see the module doc comment for the curation posture).
  {
    // The anti-over-engineering ladder pays off where approach and dependencies get chosen
    // (plan) and code gets written (implement); createPr is review-time — suggestion only.
    name: 'ralphctl-ponytail',
    defaultFor: ['plan', 'implement'],
    recommendedFor: ['createPr'],
  },
  {
    // Guardrails against silent assumptions and unverified completion bite exactly while
    // planning and implementing; no phase left to merely recommend.
    name: 'ralphctl-karpathy-guidelines',
    defaultFor: ['plan', 'implement'],
    recommendedFor: [],
  },
  {
    // Default-OFF by design: the harness already structures this skill's loop (plan gate,
    // check gate, evaluator), so it is an opt-in reinforcement, not a default.
    name: 'ralphctl-cherny-workflow',
    defaultFor: [],
    recommendedFor: ['implement', 'createPr'],
  },
  {
    // Divergent→convergent idea shaping is the ideate flow's core job; refine benefits when a
    // ticket is still fuzzy — suggestion only.
    name: 'ralphctl-idea-refinement',
    defaultFor: ['ideate'],
    recommendedFor: ['refine'],
  },
  {
    // Ubiquitous language and boundary placement sharpen requirements (refine) and drive
    // module boundaries (plan); implement keeps it as a suggestion.
    name: 'ralphctl-domain-driven-design',
    defaultFor: ['refine', 'plan'],
    recommendedFor: ['implement'],
  },
];

/**
 * Skills default-ON for `flowId`, in table order. Derived from each entry's `defaultFor`, so
 * `recommendedFor` never affects what a flow actually loads. Signature and behaviour are kept
 * from the previous flat mapping — the bundled skill source consumes this unchanged.
 */
export const skillsForFlow = (flowId: FlowId): readonly string[] =>
  BUNDLED_SKILLS.filter((entry) => entry.defaultFor.includes(flowId)).map((entry) => entry.name);
