/**
 * AI-driven flow identifiers — the closed set of flows that open an AI session and therefore
 * carry a per-flow `{ provider, model, effort? }` row in {@link Settings}. Non-AI flows
 * (doctor, export, add-ticket, …) are NOT members and do not appear in settings.ai. The
 * `createPr` slot is the camelCase counterpart of the kebab-case orchestration id
 * `create-pr` — `create-pr` only spawns AI when the user passes `--ai`, but when it does the
 * harness reads `settings.ai.createPr` for the AI step's model.
 *
 * Single source of truth. The integration-side skill registry (`integration/ai/skills/_engine/
 * registry.ts`) and the settings schema (`domain/entity/settings.ts`) both import this type
 * directly so adding a new AI flow surfaces every downstream consumer at typecheck.
 */
export type FlowId = 'refine' | 'plan' | 'implement' | 'readiness' | 'ideate' | 'createPr';

/**
 * Iteration order matches the chronological pipeline (refine → plan → implement → readiness →
 * createPr; ideate is a separate slot). Settings TUI / CLI / migration code use this tuple
 * as the canonical row order so user-facing surfaces stay aligned with the schema.
 */
export const FLOW_IDS: readonly FlowId[] = ['refine', 'plan', 'implement', 'readiness', 'ideate', 'createPr'] as const;
