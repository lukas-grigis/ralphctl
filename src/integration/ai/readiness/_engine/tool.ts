/**
 * Closed enum of AI coding-assistant tools the harness can target. The probe layer in
 * `ai/readiness/<tool>/` has one implementation per variant; the compiler keeps
 * every consumer exhaustive when a new tool is added.
 */
export type AssistantTool = 'claude-code' | 'copilot' | 'codex';

export const ASSISTANT_TOOLS: readonly AssistantTool[] = ['claude-code', 'copilot', 'codex'];
