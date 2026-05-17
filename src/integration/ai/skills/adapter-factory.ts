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
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import { createClaudeSkillsAdapter } from '@src/integration/ai/skills/claude/adapter.ts';
import { createCodexSkillsAdapter } from '@src/integration/ai/skills/codex/adapter.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';

export interface SkillsAdapterFactoryDeps {
  readonly provider: AiProvider;
}

export const createSkillsAdapter = (deps: SkillsAdapterFactoryDeps): SkillsAdapter => {
  switch (deps.provider) {
    case 'claude-code':
      return createClaudeSkillsAdapter();
    case 'github-copilot':
      return createCopilotSkillsAdapter();
    case 'openai-codex':
      return createCodexSkillsAdapter();
  }
};
