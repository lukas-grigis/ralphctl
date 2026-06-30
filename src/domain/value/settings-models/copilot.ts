// Reconciled to GitHub's official supported-models doc (as of 2026-06-30).
// Docs: https://docs.github.com/en/copilot/reference/ai-models/supported-models

/**
 * Models supported by the GitHub Copilot CLI adapter. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns. The default model is Claude Sonnet 4.5 (`claude-sonnet-4.5`).
 *
 * This catalog is reconciled to GitHub's official supported-models doc (as of 2026-06-30):
 * https://docs.github.com/en/copilot/reference/ai-models/supported-models
 *
 * Anthropic's Claude Sonnet 5 (`claude-sonnet-5`) went GA for GitHub Copilot on 2026-06-30 and is
 * listed here; its slug carries no dot/date, so the Copilot dotted-lowercase form is identical to
 * the Claude-Code dash form (`claude-sonnet-5`) — see `escalation-map.ts` for the consequence.
 *
 * The Copilot CLI cannot enumerate its model catalog non-interactively (github/copilot-cli
 * issue #700), so the slugs below are mapped from the doc's display names through the
 * established dotted-lowercase convention. They are NOT verified against the live CLI.
 *
 * This list is a full official replacement: de-listed models are dropped rather than retained.
 * The per-session model-availability probe (a passthrough for Copilot in v1) is the intended
 * mechanism for hiding models a given account cannot use — not retaining superseded entries in
 * this static catalog.
 */
export type CopilotModel =
  // OpenAI
  | 'gpt-5-mini'
  | 'gpt-5.3-codex'
  | 'gpt-5.4'
  | 'gpt-5.4-mini'
  | 'gpt-5.4-nano'
  | 'gpt-5.5'
  // Anthropic
  | 'claude-haiku-4.5'
  | 'claude-opus-4.5'
  | 'claude-opus-4.6'
  | 'claude-opus-4.6-fast'
  | 'claude-opus-4.7'
  | 'claude-opus-4.8'
  | 'claude-fable-5'
  | 'claude-sonnet-4.5'
  | 'claude-sonnet-4.6'
  | 'claude-sonnet-5'
  // Google
  | 'gemini-2.5-pro'
  | 'gemini-3-flash'
  | 'gemini-3.1-pro-preview'
  | 'gemini-3.5-flash'
  // Microsoft
  | 'mai-code-1-flash'
  // Fine-tuned
  | 'raptor-mini-preview';

export const COPILOT_MODELS: readonly CopilotModel[] = [
  // OpenAI
  'gpt-5-mini',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.5',
  // Anthropic
  'claude-haiku-4.5',
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.6-fast',
  'claude-opus-4.7',
  'claude-opus-4.8',
  'claude-fable-5',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-5',
  // Google
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  // Microsoft
  'mai-code-1-flash',
  // Fine-tuned
  'raptor-mini-preview',
] as const;

export const isCopilotModel = (s: string): s is CopilotModel => (COPILOT_MODELS as readonly string[]).includes(s);
