// Verified against the live `codex debug models` (codex CLI 0.171.0, 2026-11-21); the 6.2 ids
// need CLI >= 0.166.0. Docs: https://github.com/openai/codex#model-selection — facts cross-checked
// against https://developers.openai.com/codex/models

/**
 * Models supported by the OpenAI Codex CLI adapter.
 *
 * `gpt-6.2-sol` is the flagship — the CLI's default "fast, go-to model" and top of the Codex
 * escalation ladder; `gpt-6.1-sol`, `gpt-6-sol` and `gpt-6-astra` are older generations kept for
 * pinned configs. `gpt-6-luna` is the cheap tier ($0.10/$0.50); `gpt-6.2-astra` is the premium
 * tier — never a provider default or a built-in ladder rung, only the frontier presets pick it.
 * `gpt-6.1-terra` is catalog-only (OpenAI positions it for vision and computer use). Efforts: all
 * accept `low..max`; `ultra` exists on every model except the two lunas and `codex-auto-review`
 * (see {@link CODEX_MODEL_EFFORT_LEVELS}).
 *
 * `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` are legacy and stay for pinned configs (the
 * default ladder climbs them to the top).
 *
 * Removed ids: `gpt-5.5` (retired from Codex 2026-10-14; remapped to `gpt-6.1-sol`), `gpt-5.4` and
 * `gpt-5.4-mini` (retired 2026-08-31; remapped to `gpt-6-sol` / `gpt-6-luna`), and earlier
 * `gpt-5.2` / `gpt-5.3-codex` / `gpt-5.3-codex-spark` (remapped to `gpt-6.1-sol`). All
 * remaps live in `RETIRED_MODEL_REMAPS` (`domain/entity/settings.ts`).
 * Bare `gpt-5.6` is an API-only alias rejected under ChatGPT auth — deliberately NOT listed.
 *
 * The codex backend serves models dynamically — new entries that appear in the picker after
 * this list was captured require a one-line update here. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns. `codex-auto-review` is the CLI's automatic approval review model, kept here so
 * rows can name it.
 */
export const CODEX_MODELS = [
  'gpt-6.2-sol',
  'gpt-6.2-astra',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'codex-auto-review',
] as const;

export type CodexModel = (typeof CODEX_MODELS)[number];

export const isCodexModel = (s: string): s is CodexModel => (CODEX_MODELS as readonly string[]).includes(s);

/**
 * Reasoning-effort levels each Codex model accepts on `model_reasoning_effort`. An out-of-list
 * level is a 400 from the API (`Unsupported value: 'max' is not supported with the '<model>'
 * model`), so resolution clamps to this list. Models absent here pass through to the CLI.
 *
 * Source: `codex debug models` (codex CLI 0.171.0, 2026-11-21).
 */
export const CODEX_MODEL_EFFORT_LEVELS: Readonly<Partial<Record<CodexModel, readonly string[]>>> = {
  'gpt-6.2-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.2-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.1-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'codex-auto-review': ['low', 'medium', 'high', 'xhigh', 'max'],
};
