// Reconciled to GitHub's official supported-models doc (as of 2026-08-18).
// Docs: https://docs.github.com/en/copilot/reference/ai-models/supported-models

/**
 * Models supported by the GitHub Copilot CLI adapter. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns. The default model is Claude Sonnet 4.5 (`claude-sonnet-4.5`).
 *
 * This catalog is reconciled to GitHub's official supported-models doc (as of 2026-08-18):
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
 * fails at spawn with a clear error on gated accounts.
 *
 * The Copilot CLI cannot enumerate its model catalog non-interactively (github/copilot-cli
 * issue #700 is still open), so the slugs below are mapped from the doc's display names through
 * the established dotted-lowercase convention. Everything added or renamed in the 2026-08-18
 * pass — `gemini-3.7-flash`, `mai-code-1.1-flash`, `kimi-k3`, `grok-4.5`, `grok-4.6`,
 * `gemini-3.1-pro`, `raptor-mini` — is convention-derived and NOT validated against the live
 * CLI, as are the 2026-07-26 additions `claude-opus-4.8-fast`, `gemini-3.6-flash`, and
 * `kimi-k2.7-code`. Only the entries explicitly noted as verified above have been exercised.
 *
 * Renames in the 2026-08-18 pass follow the doc's display names: `gemini-3.1-pro-preview` →
 * `gemini-3.1-pro` (the display name dropped the preview suffix even though the doc's
 * release-status column still reads "Public preview" — the slug tracks the display name, which
 * is what the CLI accepts), and `raptor-mini-preview` → `raptor-mini` (went GA). Persisted rows
 * on the old slugs are remapped at parse time (see `RETIRED_MODEL_REMAPS` in `settings.ts`).
 *
 * xAI is a new provider group here — `grok-4.5` / `grok-4.6` are the first xAI entries.
 *
 * This list is a full official replacement: de-listed models are dropped rather than retained.
 * The per-session model-availability probe (a passthrough for Copilot in v1) is the intended
 * mechanism for hiding models a given account cannot use — not retaining superseded entries in
 * this static catalog. `claude-opus-4.6-fast` was delisted (replaced by `claude-opus-4.8-fast`);
 * `gemini-2.5-pro` and `gemini-3-flash` were delisted on 2026-08-18 (remapped to
 * `gemini-3.1-pro` and `gemini-3.5-flash` respectively).
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
  | 'gemini-3.1-pro'
  | 'gemini-3.5-flash'
  | 'gemini-3.6-flash'
  | 'gemini-3.7-flash'
  // Microsoft
  | 'mai-code-1-flash'
  | 'mai-code-1.1-flash'
  // Moonshot
  | 'kimi-k2.7-code'
  | 'kimi-k3'
  // xAI
  | 'grok-4.5'
  | 'grok-4.6'
  // Fine-tuned
  | 'raptor-mini';

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
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  // Microsoft
  'mai-code-1-flash',
  'mai-code-1.1-flash',
  // Moonshot
  'kimi-k2.7-code',
  'kimi-k3',
  // xAI
  'grok-4.5',
  'grok-4.6',
  // Fine-tuned
  'raptor-mini',
] as const;

export const isCopilotModel = (s: string): s is CopilotModel => (COPILOT_MODELS as readonly string[]).includes(s);
