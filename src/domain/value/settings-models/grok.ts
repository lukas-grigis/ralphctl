// Model ids probed with `grok models` on Grok Build CLI 1.0.40 (2026-09-22). Flag surface still
// verified against 1.0.30's shipped CLI reference (2026-09-15); minimum supported version 1.0.13
// (`-s`).

/**
 * Models supported by the Grok Build CLI adapter. `grok-4.7` is the flagship / CLI default;
 * `grok-4.6` and `grok-4.5` are the previous generations. `grok-4.7-build-fast` is the same model
 * on faster serving at twice the token price, and it is excluded from Grok Build's free tier
 * (docs.x.ai) — catalogued so a manual pin is accepted, never a preset default. Domain-owned:
 * persisted Settings reference these identifiers; adapters consume them when invoking the CLI
 * subprocess. The adapter validates `AiSession.model` against this set and surfaces
 * `InvalidStateError` for unknowns. An off-catalog id persists fine via `CustomModelStringSchema`,
 * but the adapter rejects it at argv-build time rather than forwarding it — so when xAI ships a
 * new model, this catalog has to grow (or the row has to be re-pinned). Forwarding an unknown id
 * to the CLI is OpenCode's contract, not Grok's.
 */
export type GrokModel = 'grok-4.7' | 'grok-4.7-build-fast' | 'grok-4.6' | 'grok-4.5';

export const GROK_MODELS: readonly GrokModel[] = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'] as const;

export const isGrokModel = (s: string): s is GrokModel => (GROK_MODELS as readonly string[]).includes(s);
