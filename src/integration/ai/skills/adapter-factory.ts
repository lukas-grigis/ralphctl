/**
 * `createSkillsAdapter` — composition-root factory that picks the {@link SkillsAdapter}
 * implementation matching the configured AI provider.
 *
 * All three providers now have a real filesystem adapter (the on-disk shape is identical —
 * Agent Skills SKILL.md folders — only the parent directory varies, per provider, via
 * `skillsParentDir` in `providers/_engine/provider-traits.ts`).
 *
 * Adding a new provider is one row in `provider-traits.ts` plus one row in
 * {@link SKILLS_ADAPTERS} plus a sibling `skills/<provider>/adapter.ts` that delegates to
 * {@link createFilesystemSkillsAdapter}.
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillsAdapterFactoryDeps } from '@src/integration/ai/skills/_engine/skills-adapter-factory-deps.ts';
import type { SkillsAdapterDeps } from '@src/integration/ai/skills/_engine/skills-adapter-deps.ts';
import { createClaudeSkillsAdapter } from '@src/integration/ai/skills/claude/adapter.ts';
import { createCodexSkillsAdapter } from '@src/integration/ai/skills/codex/adapter.ts';
import { createCopilotSkillsAdapter } from '@src/integration/ai/skills/copilot/adapter.ts';

/**
 * One concrete skills-adapter factory per {@link AiProvider}. `Record<AiProvider, …>` is
 * checked exhaustively by the compiler — adding a member to the `AiProvider` union without a
 * row here is a compile error.
 */
const SKILLS_ADAPTERS: Readonly<Record<AiProvider, (deps?: SkillsAdapterDeps) => SkillsAdapter>> = {
  'claude-code': createClaudeSkillsAdapter,
  'github-copilot': createCopilotSkillsAdapter,
  'openai-codex': createCodexSkillsAdapter,
};

export const createSkillsAdapter = (deps: SkillsAdapterFactoryDeps): SkillsAdapter => {
  const logger = deps.logger;
  return SKILLS_ADAPTERS[deps.provider](logger !== undefined ? { logger } : undefined);
};
