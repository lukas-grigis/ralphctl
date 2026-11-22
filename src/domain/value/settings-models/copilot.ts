// Reconciled to GitHub's supported-models doc + changelog and live-probed; the 2026-10-19 and
// 2026-11-16 deprecation batches dropped on their retirement dates.
// Docs: https://docs.github.com/en/copilot/reference/ai-models/supported-models

/**
 * Models supported by the GitHub Copilot CLI adapter. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns.
 *
 * Reconciled to GitHub's supported-models doc and changelog and to the Copilot SDK's
 * `listModels()` on a reference account (probe version and date below).
 *
 * "Not available" on one account is often plan gating or a gradual rollout, so only models GitHub
 * itself deprecated are removed. Removed so far (each remapped at parse time — `RETIRED_MODEL_REMAPS`
 * in `settings.ts`): the 2026-09-01 batch (`claude-opus-4.5` / `-4.6`, `claude-sonnet-4.5` / `-4.6`,
 * `gemini-3.1-pro`, `raptor-mini`, plus `mai-code-1-flash`), the 2026-10-02 batch
 * (`gemini-3.5-flash`, `gemini-3.6-flash`, `kimi-k2.7-code`, `claude-opus-4.7`) and the 2026-10-19
 * batch (changelog 2026-09-18; GitHub's named successors): `gpt-5.5` / `gpt-5.4` → `gpt-5.6-sol`,
 * `gpt-5.4-mini` / `gpt-5-mini` → `gpt-5.6-luna`, `gemini-3.7-flash` → `gemini-4-hydrogen`, and
 * `grok-4.5` → `grok-4.7` (Copilot only — `grok-4.5` stays on the `xai-grok` backend), and the
 * 2026-11-16 batch (changelog 2026-10-15): `claude-opus-4.8` / `claude-opus-5` → `claude-opus-5.5`
 * and `gpt-5.6-terra` → `gpt-6.1-terra`.
 *
 * Plan gating (changelog): `claude-sonnet-5.5` (2026-09-28) and `gpt-6-luna` reach Pro and up;
 * `gpt-6.1-sol` (2026-09-29), `gpt-6-sol`, `gpt-6-astra`, `claude-opus-5.5` (gated like the
 * retired Opus ids — none on Pro) and `claude-fable-5.1` are Pro+ and up. The Copilot presets top
 * out on `claude-opus-5.5`; a Pro account falls back to Sonnet 5.5 through
 * `adapt-to-available-models.ts`.
 *
 * Listed by `listModels()` on the reference account (CLI 1.0.114, 2026-11-21; account- and plan-
 * specific): `claude-sonnet-5.5`, `claude-sonnet-5`, `claude-opus-5.5`, `claude-haiku-5.5`,
 * `claude-haiku-4.5`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`,
 * `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.3-codex`, `mai-code-1.1-flash`, `grok-4.7`. `gpt-6.2-sol`,
 * `gpt-6.2-astra` and `gemini-4-hydrogen` come from GitHub's CLI command reference and are not in
 * that list, so their effort lists are unverified. `claude-fable-5.2` and `gemini-4-carbon` are
 * printed by `copilot help config` (CLI 1.0.114); `mai-code-2` and `mai-code-2-flash` are unverified —
 * taken from strings in the CLI binary, not from a listing. None is listed for the reference
 * account, so effort passes through. The remaining entries are convention-derived
 * slugs from the doc's display names, not validated against the live CLI.
 *
 * Scheduled to retire 2026-12-14 (changelog): `claude-fable-5`, `claude-haiku-4.5`,
 * `gemini-3.8-flash`, `grok-4.6`, `kimi-k3`; 2026-12-18: `mai-code-1.1-flash`. They stay listed
 * until their date.
 *
 * Claude slugs with no dot or date — `claude-sonnet-5`, `claude-fable-5` — are
 * the same string on the Copilot and Claude-Code catalogs. The escalation ladder is scoped per
 * provider (`escalation-map.ts`), so the collision no longer constrains either ladder.
 */
export const COPILOT_MODELS = [
  // OpenAI
  'gpt-5.3-codex',
  'gpt-5.4-nano',
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6.2-sol',
  'gpt-6.2-astra',
  'gpt-6-luna',
  // Anthropic
  'claude-haiku-4.5',
  'claude-haiku-5.5',
  'claude-opus-4.8-fast',
  'claude-opus-5.5',
  'claude-fable-5',
  'claude-fable-5.1',
  'claude-fable-5.2',
  'claude-sonnet-5',
  'claude-sonnet-5.5',
  // Google
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
  'gemini-4-carbon',
  // Microsoft
  'mai-code-1.1-flash',
  'mai-code-2',
  'mai-code-2-flash',
  // Moonshot
  'kimi-k3',
  // xAI
  'grok-4.6',
  'grok-4.7',
] as const;

export type CopilotModel = (typeof COPILOT_MODELS)[number];

export const isCopilotModel = (s: string): s is CopilotModel => (COPILOT_MODELS as readonly string[]).includes(s);

/**
 * Reasoning-effort levels each Copilot model accepts on `--effort`; `[]` = the model has no
 * effort dimension and the CLI exits 1 on ANY level (`Model "claude-haiku-4.5" does not support
 * reasoning effort configuration`). Models absent here are unverified — effort passes through and
 * the CLI arbitrates. An out-of-list level also exits 1 (`Reasoning effort "max" is not supported
 * for model "<model>"`), so resolution clamps to this list.
 *
 * Source: the Copilot SDK's `listModels()` (`capabilities.supports.reasoningEffort` +
 * `supportedReasoningEfforts`) against Copilot CLI 1.0.114 on the reference account, 2026-11-21.
 */
export const COPILOT_MODEL_EFFORT_LEVELS: Readonly<Partial<Record<CopilotModel, readonly string[]>>> = {
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-haiku-4.5': [],
  'claude-haiku-5.5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5.5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5.1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5.5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'mai-code-1.1-flash': ['low', 'medium', 'high'],
  'grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.7': ['low', 'medium', 'high', 'xhigh'],
};
