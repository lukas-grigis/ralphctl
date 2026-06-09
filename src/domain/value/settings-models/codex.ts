// Verified against the `codex -m` picker (OpenAI Codex CLI v0.138.0).
// Docs: https://github.com/openai/codex#model-selection — facts cross-checked against
// https://developers.openai.com/codex/models

/**
 * Models supported by the OpenAI Codex CLI adapter. Enumerated from the `codex -m`
 * picker (codex v0.138.0): `gpt-5.5` is the frontier default — the model `codex-only` runs
 * implement on and the top rung of the Codex escalation ladder; `gpt-5.4` is the strong
 * frontier coder one tier below it (where the economic preset starts implement before climbing
 * to `gpt-5.5` on a plateau); `gpt-5.4-mini` is the efficient/mini tier; `gpt-5.3-codex-spark`
 * is a text-only research preview surfaced to ChatGPT Pro accounts only. `gpt-5.2` and
 * `gpt-5.3-codex` are DEPRECATED for ChatGPT sign-in but kept in the allowlist because they
 * remain available via API-key auth — removing them would break pinned configs. The codex
 * backend serves models dynamically — new entries that appear in the picker after this list
 * was captured require a one-line update here. Domain-owned: persisted Settings reference
 * these identifiers; adapters consume them when invoking the CLI subprocess. The adapter
 * validates `AiSession.model` against this set and surfaces `InvalidStateError` for unknowns.
 * `codex-auto-review` is the synthetic model id the CLI uses for its review subcommand and is
 * kept here so review chains can name it.
 */
export type CodexModel =
  | 'gpt-5.5'
  | 'gpt-5.4'
  | 'gpt-5.4-mini'
  | 'gpt-5.3-codex-spark'
  | 'gpt-5.3-codex'
  | 'gpt-5.2'
  | 'codex-auto-review';

export const CODEX_MODELS: readonly CodexModel[] = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'gpt-5.3-codex',
  'gpt-5.2',
  'codex-auto-review',
] as const;

export const isCodexModel = (s: string): s is CodexModel => (CODEX_MODELS as readonly string[]).includes(s);
