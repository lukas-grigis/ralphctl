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
 * Default-set curation: a skill is default-ON only in the phases where its discipline is the
 * prompt's missing piece and nothing it says contradicts that phase's prompt. Every default costs
 * context on every session of its phase, and implement's evaluator shares the generator's skill
 * set, so defaults stay few. Everything else is catalog-only: topic-specific skills fit only some
 * tasks, and the reinforcement skills restate what a prompt already owns. The per-run / per-flow
 * opt-out (`settings.ai.skills`, customize-picker skills step) trims any default.
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

import type { FlowId } from '@src/domain/value/flow-id.ts';

export type { FlowId };

/**
 * One bundled skill and its phase assignments. `name` must match a `bundled/<name>/SKILL.md`
 * folder (and, per the Agent Skills spec, that file's frontmatter `name`); the `ralphctl-`
 * prefix is required.
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
 */
export const BUNDLED_SKILLS: readonly BundledSkillEntry[] = [
  // Default-ON skills first — table order is install order.
  {
    // The approach ladder (reuse, stdlib, an installed dependency) is the only implementation-
    // choice guidance plan and implement get. Not for createPr: the diff-only PR author cannot
    // honestly name what was skipped.
    name: 'ralphctl-ponytail',
    defaultFor: ['plan', 'implement'],
    recommendedFor: [],
  },
  {
    // The evaluator and the best-of-N judge share implement's skill set; the review axes sharpen
    // their evidence-gathering. readiness has no code under review and createPr drops review
    // signals.
    name: 'ralphctl-code-review-and-quality',
    defaultFor: ['implement'],
    recommendedFor: [],
  },
  {
    // Trust-boundary tiers match implement's blocked rules; plan has no security guidance of its
    // own, so authorising sensitive changes in task steps is a suggestion there.
    name: 'ralphctl-security-and-hardening',
    defaultFor: ['implement'],
    recommendedFor: ['plan'],
  },
  {
    // Execute-phase only: plan's tests-with-feature coupling lives in task-sizing, and readiness
    // runs no tests.
    name: 'ralphctl-test-driven-development',
    defaultFor: ['implement'],
    recommendedFor: [],
  },
  {
    // Only implement debugs anything; readiness is read-only inspection.
    name: 'ralphctl-debugging-and-error-recovery',
    defaultFor: ['implement'],
    recommendedFor: [],
  },
  {
    // Turning a raw idea into a direction is ideate's core job. Not refine: generating variations
    // contradicts refine's elicit-don't-design rule (ralphctl-ambition is the opt-in there).
    name: 'ralphctl-idea-refinement',
    defaultFor: ['ideate'],
    recommendedFor: [],
  },
  {
    // readiness's whole output is always-loaded context. plan writes task specs cold agents read,
    // and implement tasks sometimes edit AGENTS.md or skills; refine's requirements are agent-read.
    name: 'ralphctl-writing-for-agents',
    defaultFor: ['readiness'],
    recommendedFor: ['refine', 'plan', 'implement'],
  },
  // Opt-in reinforcements — the prompt already owns the discipline, so these are catalog-only.
  {
    // A stricter scope voice for operators who want one; implement's prompt plus ponytail already
    // cover scope, and plan restates its assumption and success-criteria modes.
    name: 'ralphctl-karpathy-guidelines',
    defaultFor: [],
    recommendedFor: ['implement', 'plan'],
  },
  {
    // refine and ideate own the requirements output and its approval gate; this only sharpens
    // the body and adds no files or gates.
    name: 'ralphctl-spec-driven-development',
    defaultFor: [],
    recommendedFor: ['refine', 'ideate'],
  },
  {
    // Widens the ask before it is pinned down. Never implement (the evaluator shares that set and
    // would grade against criteria nobody asked for) and never createPr (nothing to raise).
    name: 'ralphctl-ambition',
    defaultFor: [],
    recommendedFor: ['ideate', 'refine', 'plan'],
  },
  {
    // The PR body is human-facing prose with no contract conflict. Not refine: its formatting
    // rules clash with refine's prescribed output template.
    name: 'ralphctl-humanizer',
    defaultFor: [],
    recommendedFor: ['createPr'],
  },
  // Topic-specific — default-OFF; each suggests only the phases where its topic gets decided or
  // written.
  {
    // Valuable for domain-heavy business code, noise for CLIs, libraries and UIs.
    name: 'ralphctl-domain-driven-design',
    defaultFor: [],
    recommendedFor: ['refine', 'plan', 'implement'],
  },
  {
    // Interface contracts get decided in plan steps and written in implement.
    name: 'ralphctl-api-and-interface-design',
    defaultFor: [],
    recommendedFor: ['plan', 'implement'],
  },
  {
    // Measuring needs a shell, which only implement has.
    name: 'ralphctl-performance-optimization',
    defaultFor: [],
    recommendedFor: ['implement'],
  },
  {
    // UI states and accessibility land in the code itself — implement only.
    name: 'ralphctl-frontend-ui-engineering',
    defaultFor: [],
    recommendedFor: ['implement'],
  },
  {
    // plan sequences expand / migrate / contract; implement carries out one phase per task.
    name: 'ralphctl-deprecation-and-migration',
    defaultFor: [],
    recommendedFor: ['plan', 'implement'],
  },
  {
    // Behaviour-preserving refactoring needs the test loop, so implement only.
    name: 'ralphctl-code-simplification',
    defaultFor: [],
    recommendedFor: ['implement'],
  },
  {
    // Version-grounded API use matters when plan names a pattern and when implement writes it.
    name: 'ralphctl-source-driven-development',
    defaultFor: [],
    recommendedFor: ['implement', 'plan'],
  },
  {
    // Telemetry belongs with the feature: planned in task steps, written in implement.
    name: 'ralphctl-observability-and-instrumentation',
    defaultFor: [],
    recommendedFor: ['implement', 'plan'],
  },
  {
    // Module depth and seam placement are decided when work is split and when code is written.
    name: 'ralphctl-codebase-design',
    defaultFor: [],
    recommendedFor: ['plan', 'implement'],
  },
];

/**
 * Skills default-ON for `flowId`, in table order. Derived from each entry's `defaultFor`, so
 * `recommendedFor` never affects what a flow actually loads. Signature and behaviour are kept
 * from the previous flat mapping — the bundled skill source consumes this unchanged.
 */
export const skillsForFlow = (flowId: FlowId): readonly string[] =>
  BUNDLED_SKILLS.filter((entry) => entry.defaultFor.includes(flowId)).map((entry) => entry.name);
