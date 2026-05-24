// Verified against `copilot --help` / `copilot help config` (GitHub Copilot CLI v1.0.12+).
// Docs: https://docs.github.com/en/copilot/github-copilot-in-the-cli

/**
 * Models supported by the GitHub Copilot CLI adapter. Enumerated from `copilot help config`
 * (v1.0.12). Domain-owned: persisted Settings reference these identifiers; adapters consume
 * them when invoking the CLI subprocess. The adapter validates `AiSession.model` against this
 * set and surfaces `InvalidStateError` for unknowns.
 */
export type CopilotModel =
  | 'gpt-5-mini'
  | 'gpt-5.4-mini'
  | 'gpt-5.1'
  | 'gpt-5.4'
  | 'gpt-5.3-codex'
  | 'gpt-5.2-codex'
  | 'gpt-5.2'
  | 'gpt-5.1-codex-max'
  | 'gpt-5.1-codex'
  | 'gpt-5.1-codex-mini'
  | 'gpt-4.1'
  | 'claude-haiku-4.5'
  | 'claude-sonnet-4.6'
  | 'claude-sonnet-4.5'
  | 'claude-sonnet-4'
  | 'claude-opus-4.6'
  | 'claude-opus-4.6-fast'
  | 'claude-opus-4.5'
  | 'gemini-3-pro-preview';

export const COPILOT_MODELS: readonly CopilotModel[] = [
  'gpt-5-mini',
  'gpt-5.4-mini',
  'gpt-5.1',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-4.1',
  'claude-haiku-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-opus-4.6',
  'claude-opus-4.6-fast',
  'claude-opus-4.5',
  'gemini-3-pro-preview',
] as const;

export const isCopilotModel = (s: string): s is CopilotModel => (COPILOT_MODELS as readonly string[]).includes(s);
