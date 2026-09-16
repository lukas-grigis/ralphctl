// Verified against Grok Build CLI 1.0.30's shipped CLI reference on 2026-09-15; minimum supported
// version 1.0.13 (`-s`).

/**
 * Models supported by the Grok Build CLI adapter. `grok-4.6` is the flagship / default;
 * `grok-4.5` is the previous generation. Domain-owned: persisted Settings reference these
 * identifiers; adapters consume them when invoking the CLI subprocess. The adapter validates
 * `AiSession.model` against this set and surfaces `InvalidStateError` for unknowns. An off-catalog
 * id persists fine via `CustomModelStringSchema`, but the adapter rejects it at argv-build time
 * rather than forwarding it — so when xAI ships a new model, this catalog has to grow (or the row
 * has to be re-pinned). Forwarding an unknown id to the CLI is OpenCode's contract, not Grok's.
 */
export type GrokModel = 'grok-4.6' | 'grok-4.5';

export const GROK_MODELS: readonly GrokModel[] = ['grok-4.6', 'grok-4.5'] as const;

export const isGrokModel = (s: string): s is GrokModel => (GROK_MODELS as readonly string[]).includes(s);
