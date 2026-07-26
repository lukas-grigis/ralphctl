// Reconciled to GitHub's official supported-models doc (as of 2026-07-26).
// Docs: https://docs.github.com/en/copilot/reference/ai-models/supported-models

/**
 * Models supported by the GitHub Copilot CLI adapter. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns. The default model is Claude Sonnet 4.5 (`claude-sonnet-4.5`).
 *
 * This catalog is reconciled to GitHub's official supported-models doc (as of 2026-07-26):
 * https://docs.github.com/en/copilot/reference/ai-models/supported-models
 *
 * Anthropic's Claude Sonnet 5 (`claude-sonnet-5`) went GA for GitHub Copilot on 2026-06-30 and is
 * listed here; its slug carries no dot/date, so the Copilot dotted-lowercase form is identical to
 * the Claude-Code dash form (`claude-sonnet-5`) — see `escalation-map.ts` for the consequence.
 * `claude-opus-5` joins `claude-sonnet-5` / `claude-fable-5` as an undotted shared-slug id
 * identical to the Claude-Code id — same consequence, see `escalation-map.ts`.
 *
 * `gpt-5.6-sol` was verified working via the Copilot CLI (1.0.75). `claude-opus-5` is
 * plan-gated (Pro+/Max/Business/Enterprise) and — per the existing passthrough-probe policy —
 * fails at spawn with a clear error on gated accounts. `claude-opus-4.8-fast`,
 * `gemini-3.6-flash`, and `kimi-k2.7-code` slugs are convention-derived from the doc's display
 * names (could not be validated on the reference account).
 *
 * The Copilot CLI cannot enumerate its model catalog non-interactively (github/copilot-cli
 * issue #700), so the slugs below are mapped from the doc's display names through the
 * established dotted-lowercase convention. They are NOT verified against the live CLI (except
 * where noted above).
 *
 * This list is a full official replacement: de-listed models are dropped rather than retained.
 * The per-session model-availability probe (a passthrough for Copilot in v1) is the intended
 * mechanism for hiding models a given account cannot use — not retaining superseded entries in
 * this static catalog. `claude-opus-4.6-fast` was delisted (replaced by `claude-opus-4.8-fast`).
 */
export type CopilotModel =
  // OpenAI
  | 'gpt-5-mini'
  | 'gpt-5.3-codex'
  | 'gpt-5.4'
  | 'gpt-5.4-mini'
  | 'gpt-5.4-nano'
  | 'gpt-5.5'
  | 'gpt-5.6-sol'
  | 'gpt-5.6-terra'
  | 'gpt-5.6-luna'
  // Anthropic
  | 'claude-haiku-4.5'
  | 'claude-opus-4.5'
  | 'claude-opus-4.6'
  | 'claude-opus-4.7'
  | 'claude-opus-4.8'
  | 'claude-opus-4.8-fast'
  | 'claude-opus-5'
  | 'claude-fable-5'
  | 'claude-sonnet-4.5'
  | 'claude-sonnet-4.6'
  | 'claude-sonnet-5'
  // Google
  | 'gemini-2.5-pro'
  | 'gemini-3-flash'
  | 'gemini-3.1-pro-preview'
  | 'gemini-3.5-flash'
  | 'gemini-3.6-flash'
  // Microsoft
  | 'mai-code-1-flash'
  // Moonshot
  | 'kimi-k2.7-code'
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
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  // Anthropic
  'claude-haiku-4.5',
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.7',
  'claude-opus-4.8',
  'claude-opus-4.8-fast',
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-5',
  // Google
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  // Microsoft
  'mai-code-1-flash',
  // Moonshot
  'kimi-k2.7-code',
  // Fine-tuned
  'raptor-mini-preview',
] as const;

export const isCopilotModel = (s: string): s is CopilotModel => (COPILOT_MODELS as readonly string[]).includes(s);
