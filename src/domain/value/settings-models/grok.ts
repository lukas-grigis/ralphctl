// Verified against grok CLI 1.0.5 `grok models`.

/**
 * Models supported by the Grok Build CLI adapter. `grok-4.6` is the flagship / default;
 * `grok-4.5` is the previous generation. Domain-owned: persisted Settings reference these
 * identifiers; adapters consume them when invoking the CLI subprocess. The adapter validates
 * `AiSession.model` against this set and surfaces `InvalidStateError` for unknowns. Off-catalog
 * strings still round-trip via `CustomModelStringSchema` and are the CLI's problem at spawn.
 */
export type GrokModel = 'grok-4.6' | 'grok-4.5';

export const GROK_MODELS: readonly GrokModel[] = ['grok-4.6', 'grok-4.5'] as const;

export const isGrokModel = (s: string): s is GrokModel => (GROK_MODELS as readonly string[]).includes(s);
