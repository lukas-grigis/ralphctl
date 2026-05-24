/**
 * AI-driven flow identifiers — the closed set of flows that open an AI session and therefore
 * carry a per-flow `{ provider, model, effort? }` row in {@link Settings}. Non-AI flows
 * (doctor, create-pr without AI, export, ticket-add, …) are NOT members and do not appear in
 * settings.ai.
 *
 * Single source of truth. The integration-side skill registry (`integration/ai/skills/_engine/
 * registry.ts`) and the settings schema (`domain/entity/settings.ts`) both import this type
 * directly so adding a new AI flow surfaces every downstream consumer at typecheck.
 */
export type FlowId = 'refine' | 'plan' | 'implement' | 'readiness' | 'ideate';

/**
 * Iteration order matches the chronological pipeline (refine → plan → implement → readiness →
 * ideate is a separate slot). Settings TUI / CLI / migration code use this tuple as the
 * canonical row order so user-facing surfaces stay aligned with the schema.
 */
export const FLOW_IDS: readonly FlowId[] = ['refine', 'plan', 'implement', 'readiness', 'ideate'] as const;
