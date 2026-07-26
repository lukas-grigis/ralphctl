// Verified against the live CLI model cache (codex CLI v0.145.0, `~/.codex/models_cache.json`,
// 2026-07-26). Docs: https://github.com/openai/codex#model-selection — facts cross-checked
// against https://developers.openai.com/codex/models

/**
 * Models supported by the OpenAI Codex CLI adapter. `gpt-5.6-sol` is the flagship / top rung of
 * the Codex escalation ladder; `gpt-5.6-terra` is the balanced everyday tier; `gpt-5.6-luna` is
 * the most cost-efficient tier in the 5.6 family. `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` remain
 * served for pinned configs. The 5.6 family requires codex CLI ≥ ~0.145 — older CLIs reject
 * these ids with "requires a newer version of Codex". Bare `gpt-5.6` is an API-only alias
 * rejected under ChatGPT auth — deliberately NOT listed here.
 *
 * `gpt-5.2`, `gpt-5.3-codex`, and `gpt-5.3-codex-spark` are gone from the codex CLI entirely and
 * were REMOVED from this catalog; persisted rows pinned to any of the three are silently
 * remapped to `gpt-5.5` at parse time (see `domain/entity/settings.ts`).
 *
 * The codex backend serves models dynamically — new entries that appear in the picker after
 * this list was captured require a one-line update here. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns. `codex-auto-review` is the synthetic model id the CLI uses for its review
 * subcommand and is kept here so review chains can name it.
 */
export type CodexModel =
  'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna' | 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.4-mini' | 'codex-auto-review';

export const CODEX_MODELS: readonly CodexModel[] = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'codex-auto-review',
] as const;

export const isCodexModel = (s: string): s is CodexModel => (CODEX_MODELS as readonly string[]).includes(s);
