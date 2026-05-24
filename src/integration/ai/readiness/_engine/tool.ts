import type { AiProvider } from '@src/domain/entity/settings.ts';

/**
 * Closed enum of AI coding-assistant tools the harness can target. The probe layer in
 * `ai/readiness/<tool>/` has one implementation per variant; the compiler keeps
 * every consumer exhaustive when a new tool is added.
 */
export type AssistantTool = 'claude-code' | 'copilot' | 'codex';

/**
 * Map an {@link AiProvider} to the matching {@link AssistantTool}. Used by the readiness flow
 * to translate the per-flow provider rows (`settings.ai.<flow>.provider`) into the tool whose
 * native context file the harness writes (`CLAUDE.md` / `.github/copilot-instructions.md` /
 * `AGENTS.md`).
 */
export const toolForProvider = (provider: AiProvider): AssistantTool => {
  switch (provider) {
    case 'claude-code':
      return 'claude-code';
    case 'github-copilot':
      return 'copilot';
    case 'openai-codex':
      return 'codex';
  }
};
