// Verified against the live CLI model cache (codex CLI v0.155.1, `~/.codex/models_cache.json`,
// 2026-09-22). Docs: https://github.com/openai/codex#model-selection — facts cross-checked
// against https://developers.openai.com/codex/models

/**
 * Models supported by the OpenAI Codex CLI adapter.
 *
 * The GPT-6 family is current: `gpt-6-sol` is the flagship and the top rung of the Codex
 * escalation ladder ($2/$10 per MTok — half the `gpt-5.6-sol` price); `gpt-6-luna` is the cheap
 * tier ($0.10/$0.50); `gpt-6-astra` is the premium tier ($10/$50) and is opt-in only, never a
 * built-in ladder rung. Efforts: all three accept `low..max`; `ultra` exists on astra and sol but
 * NOT luna. Per-model narrowing is left to the codex CLI at spawn.
 *
 * `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` and `gpt-5.5` stay for pinned configs (the
 * codex cache lists 5.6-sol/terra → gpt-6-sol and 5.6-luna → gpt-6-luna as their upgrades, and the
 * default ladder climbs them there). `gpt-5.5` retires from Codex on 2026-10-14 — drop it (with a
 * parse-time remap) once that date passes.
 *
 * Removed ids: `gpt-5.4` and `gpt-5.4-mini` (retired from Codex 2026-08-31; remapped to
 * `gpt-6-sol` / `gpt-6-luna`), and earlier `gpt-5.2` / `gpt-5.3-codex` / `gpt-5.3-codex-spark`
 * (remapped to `gpt-5.5`). All remaps live in `RETIRED_MODEL_REMAPS` (`domain/entity/settings.ts`).
 * Bare `gpt-5.6` is an API-only alias rejected under ChatGPT auth — deliberately NOT listed.
 *
 * The codex backend serves models dynamically — new entries that appear in the picker after
 * this list was captured require a one-line update here. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns. `codex-auto-review` is the synthetic model id the CLI uses for its review
 * subcommand and is kept here so review chains can name it.
 */
export type CodexModel =
  | 'gpt-6-astra'
  | 'gpt-6-sol'
  | 'gpt-6-luna'
  | 'gpt-5.6-sol'
  | 'gpt-5.6-terra'
  | 'gpt-5.6-luna'
  | 'gpt-5.5'
  | 'codex-auto-review';

export const CODEX_MODELS: readonly CodexModel[] = [
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'codex-auto-review',
] as const;

export const isCodexModel = (s: string): s is CodexModel => (CODEX_MODELS as readonly string[]).includes(s);
