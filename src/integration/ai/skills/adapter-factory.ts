/**
 * `createSkillsAdapter` — composition-root factory that picks the {@link SkillsAdapter}
 * implementation matching the configured AI provider.
 *
 * All three providers now have a real filesystem adapter (the on-disk shape is identical —
 * Agent Skills SKILL.md folders — only the parent directory varies):
 *  - claude  → `.claude/skills/`
 *  - codex   → `.agents/skills/`
 *  - copilot → `.github/skills/`
 *
 * Adding a new provider is one arm here plus a sibling `skills/<provider>/adapter.ts` that
 * delegates to {@link createFilesystemSkillsAdapter}.
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import { createClaudeSkillsAdapter } from '@src/integration/ai/skills/claude/adapter.ts';
import { createCodexSkillsAdapter } from '@src/integration/ai/skills/codex/adapter.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';

export interface SkillsAdapterFactoryDeps {
  readonly provider: AiProvider;
  /** Optional logger — surfaces best-effort `.git/info/exclude` write failures as warnings. */
  readonly logger?: Logger;
}

export const createSkillsAdapter = (deps: SkillsAdapterFactoryDeps): SkillsAdapter => {
  const logger = deps.logger;
  switch (deps.provider) {
    case 'claude-code':
      return createClaudeSkillsAdapter(logger !== undefined ? { logger } : undefined);
    case 'github-copilot':
      return createCopilotSkillsAdapter(logger !== undefined ? { logger } : undefined);
    case 'openai-codex':
      return createCodexSkillsAdapter(logger !== undefined ? { logger } : undefined);
  }
};
