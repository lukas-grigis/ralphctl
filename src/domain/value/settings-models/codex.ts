// Verified against the `codex -m` picker (OpenAI Codex CLI v0.140.x).
// Docs: https://github.com/openai/codex#model-selection

/**
 * Models supported by the OpenAI Codex CLI adapter. Enumerated from the `codex -m`
 * picker (codex v0.140.x): `gpt-5.5` is the frontier default; `gpt-5.4` is the
 * everyday-coding tier; `gpt-5.4-mini` is the cheap/fast tier; `gpt-5.3-codex` is the
 * coding-specialised variant; `gpt-5.2` is tuned for long-running agents. The codex
 * backend serves models dynamically — new entries that appear in the picker after
 * this list was captured require a one-line update here. Domain-owned: persisted
 * Settings reference these identifiers; adapters consume them when invoking the CLI
 * subprocess. The adapter validates `AiSession.model` against this set and surfaces
 * `InvalidStateError` for unknowns. `codex-auto-review` is the synthetic model id
 * the CLI uses for its review subcommand and is kept here so review chains can name it.
 */
export type CodexModel = 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex' | 'gpt-5.2' | 'codex-auto-review';

export const CODEX_MODELS: readonly CodexModel[] = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
  'codex-auto-review',
] as const;

export const isCodexModel = (s: string): s is CodexModel => (CODEX_MODELS as readonly string[]).includes(s);
