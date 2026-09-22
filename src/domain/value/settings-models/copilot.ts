// Reconciled to GitHub's supported-models doc + changelog and live-probed (2026-09-22).
// Docs: https://docs.github.com/en/copilot/reference/ai-models/supported-models

/**
 * Models supported by the GitHub Copilot CLI adapter. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns.
 *
 * Reconciled to GitHub's supported-models doc and changelog (as of 2026-09-22) and live-probed
 * with the Copilot CLI (1.0.79 / 1.0.88) on a reference account the same day:
 * https://docs.github.com/en/copilot/reference/ai-models/supported-models
 *
 * "Not available" on one account is often plan gating or a gradual rollout, so only models GitHub
 * itself deprecated are removed. The 2026-09-01 deprecation (changelog 2026-08-31) removed
 * `claude-opus-4.5`, `claude-opus-4.6`, `claude-sonnet-4.5`, `claude-sonnet-4.6` (kept upstream
 * only for individual annual-plan subscribers), `gemini-3.1-pro`, and `raptor-mini`;
 * `mai-code-1-flash` was dropped as superseded by `mai-code-1.1-flash`. Persisted rows on any of
 * them are remapped at parse time (see `RETIRED_MODEL_REMAPS` in `settings.ts`).
 *
 * New in the 2026-09 changelog and cataloged here: `claude-opus-5.5` (Pro+/Max/Business/
 * Enterprise), `claude-fable-5.1` (Pro+ and up, off by default for Business/Enterprise),
 * `gpt-6-astra` (Pro+ and up), `gpt-6-sol` / `gpt-6-luna` (luna includes Pro), `gemini-3.8-flash`,
 * and `grok-4.7` (gradual rollout). None of these answered on the reference account yet, so they
 * are catalog + pin-only: a gated account fails at spawn with a clear error (the Copilot
 * availability probe is a passthrough in v1).
 *
 * Verified available on the reference account: `claude-sonnet-5`, `claude-opus-4.8`,
 * `claude-opus-4.7`, `claude-opus-5`, `claude-haiku-4.5`, `gpt-5-mini`, `gpt-5.4-mini`,
 * `gpt-5.3-codex`, `gpt-5.5`, `gpt-5.6-sol` / `-terra` / `-luna`, `gemini-3.8-flash`,
 * `mai-code-1.1-flash`, and `grok-4.6`. The remaining entries are convention-derived slugs from
 * the doc's display names (the Copilot CLI cannot enumerate its catalog non-interactively —
 * github/copilot-cli issue #700) and are not validated against the live CLI.
 *
 * Claude slugs with no dot or date — `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5` — are
 * the same string on the Copilot and Claude-Code catalogs. The escalation ladder is scoped per
 * provider (`escalation-map.ts`), so the collision no longer constrains either ladder.
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
  | 'gpt-6-astra'
  | 'gpt-6-sol'
  | 'gpt-6-luna'
  // Anthropic
  | 'claude-haiku-4.5'
  | 'claude-opus-4.7'
  | 'claude-opus-4.8'
  | 'claude-opus-4.8-fast'
  | 'claude-opus-5'
  | 'claude-opus-5.5'
  | 'claude-fable-5'
  | 'claude-fable-5.1'
  | 'claude-sonnet-5'
  // Google
  | 'gemini-3.5-flash'
  | 'gemini-3.6-flash'
  | 'gemini-3.7-flash'
  | 'gemini-3.8-flash'
  // Microsoft
  | 'mai-code-1.1-flash'
  // Moonshot
  | 'kimi-k2.7-code'
  | 'kimi-k3'
  // xAI
  | 'grok-4.5'
  | 'grok-4.6'
  | 'grok-4.7';

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
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  // Anthropic
  'claude-haiku-4.5',
  'claude-opus-4.7',
  'claude-opus-4.8',
  'claude-opus-4.8-fast',
  'claude-opus-5',
  'claude-opus-5.5',
  'claude-fable-5',
  'claude-fable-5.1',
  'claude-sonnet-5',
  // Google
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  // Microsoft
  'mai-code-1.1-flash',
  // Moonshot
  'kimi-k2.7-code',
  'kimi-k3',
  // xAI
  'grok-4.5',
  'grok-4.6',
  'grok-4.7',
] as const;

export const isCopilotModel = (s: string): s is CopilotModel => (COPILOT_MODELS as readonly string[]).includes(s);
