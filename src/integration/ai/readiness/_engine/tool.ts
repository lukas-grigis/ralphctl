import type { AiProvider } from '@src/domain/entity/settings.ts';

/**
 * Closed enum of AI coding-assistant tools the harness can target. The probe layer in
 * `ai/readiness/<tool>/` has one implementation per variant; the compiler keeps
 * every consumer exhaustive when a new tool is added.
 */
export type AssistantTool = 'claude-code' | 'copilot' | 'codex';

/** The `claude-code` id — shared literal between both directions of the provider/tool mapping below. */
const CLAUDE_CODE_ID = 'claude-code' as const;

/**
 * Map an {@link AiProvider} to the matching {@link AssistantTool}. Used by the readiness flow
 * to translate the per-flow provider rows (`settings.ai.<flow>.provider`) into the tool whose
 * native context file the harness writes (`CLAUDE.md` / `.github/copilot-instructions.md` /
 * `AGENTS.md`).
 */
export const toolForProvider = (provider: AiProvider): AssistantTool => {
  switch (provider) {
    case CLAUDE_CODE_ID:
      return CLAUDE_CODE_ID;
    case 'github-copilot':
      return 'copilot';
    case 'openai-codex':
      return 'codex';
  }
};

/**
 * Inverse of {@link toolForProvider} — maps an {@link AssistantTool} back to the
 * {@link AiProvider} that drives it. Used to key provider-level static data (e.g.
 * `PROVIDER_TRAITS`) from readiness code, which speaks `AssistantTool`.
 */
export const providerForTool = (tool: AssistantTool): AiProvider => {
  switch (tool) {
    case CLAUDE_CODE_ID:
      return CLAUDE_CODE_ID;
    case 'copilot':
      return 'github-copilot';
    case 'codex':
      return 'openai-codex';
  }
};
