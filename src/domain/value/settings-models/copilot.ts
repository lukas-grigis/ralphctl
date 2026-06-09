// Verified against `copilot --help` / `copilot help config` (GitHub Copilot CLI v1.0.60).
// Docs: https://docs.github.com/en/copilot/reference/ai-models/supported-models

/**
 * Models supported by the GitHub Copilot CLI adapter. Domain-owned: persisted Settings
 * reference these identifiers; adapters consume them when invoking the CLI subprocess. The
 * adapter validates `AiSession.model` against this set and surfaces `InvalidStateError` for
 * unknowns. The default model is Claude Sonnet 4.5.
 *
 * The Copilot CLI cannot enumerate its model catalog non-interactively (github/copilot-cli
 * issue #700), so the newer Gemini / Microsoft (`mai-code`) / Raptor identifiers below are
 * INFERRED from the GitHub supported-models doc display names mapped through the established
 * dotted-lowercase convention used by the older entries. Older entries stay verbatim — kept
 * even when superseded so pinned configs do not break.
 */
export type CopilotModel =
  | 'gpt-5-mini'
  | 'gpt-5.4-mini'
  | 'gpt-5.1'
  | 'gpt-5.4'
  | 'gpt-5.5'
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
  | 'claude-opus-4.8'
  | 'claude-opus-4.7'
  | 'claude-opus-4.6'
  | 'claude-opus-4.6-fast'
  | 'claude-opus-4.5'
  | 'gemini-3.1-pro-preview'
  | 'gemini-3-pro-preview'
  | 'gemini-3-flash-preview'
  | 'gemini-3.5-flash'
  | 'gemini-2.5-pro'
  | 'mai-code-1-flash'
  | 'raptor-mini-preview';

export const COPILOT_MODELS: readonly CopilotModel[] = [
  'gpt-5-mini',
  'gpt-5.4-mini',
  'gpt-5.1',
  'gpt-5.4',
  'gpt-5.5',
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
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.6-fast',
  'claude-opus-4.5',
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-2.5-pro',
  'mai-code-1-flash',
  'raptor-mini-preview',
] as const;

export const isCopilotModel = (s: string): s is CopilotModel => (COPILOT_MODELS as readonly string[]).includes(s);
