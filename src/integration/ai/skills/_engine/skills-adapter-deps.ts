import type { Logger } from '@src/business/observability/logger.ts';

/**
 * Composition-root inputs shared by every per-tool {@link SkillsAdapter} factory (claude / codex
 * / copilot). The on-disk shape is identical across providers — Agent Skills SKILL.md folders —
 * so the per-tool factories (`createClaudeSkillsAdapter`, `createCodexSkillsAdapter`,
 * `createCopilotSkillsAdapter`, …) differ only in `parentDir` (read from `PROVIDER_TRAITS`) and
 * convention text, never in the shape of what the composition root passes in. One interface
 * covers them all.
 */
export interface SkillsAdapterDeps {
  readonly logger?: Logger;
}
