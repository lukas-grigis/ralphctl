/**
 * `createAgentDefinitionAdapter` — composition-root factory that picks the
 * {@link AgentDefinitionAdapter} implementation matching the configured AI provider.
 *
 * All three providers share the same on-disk shape — one native file per definition under
 * `<parentDir>/agents/` — only the parent directory and render format vary:
 *  - claude  → `.claude/agents/*.md`   (Markdown + YAML frontmatter)
 *  - copilot → `.github/agents/*.agent.md` (Markdown + YAML frontmatter)
 *  - codex   → `.codex/agents/*.toml`  (TOML)
 *
 * Adding a new provider is one row in {@link AGENT_ADAPTERS} plus a sibling
 * `agents/<provider>/adapter.ts` that delegates to {@link createFilesystemAgentDefinitionAdapter}.
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import { createClaudeAgentDefinitionAdapter } from '@src/integration/ai/agents/claude/adapter.ts';
import { createCodexAgentDefinitionAdapter } from '@src/integration/ai/agents/codex/adapter.ts';
import { createOpencodeAgentDefinitionAdapter } from '@src/integration/ai/agents/opencode/adapter.ts';
import { createCopilotAgentDefinitionAdapter } from '@src/integration/ai/agents/copilot/adapter.ts';

export interface AgentDefinitionAdapterFactoryDeps {
  readonly provider: AiProvider;
  /** Optional logger — surfaces best-effort `.git/info/exclude` write failures as warnings. */
  readonly logger?: Logger;
}

/**
 * One concrete agent-definition-adapter factory per {@link AiProvider}. `Record<AiProvider, …>`
 * is checked exhaustively by the compiler — adding a member to the `AiProvider` union without a
 * row here is a compile error.
 */
const AGENT_ADAPTERS: Readonly<Record<AiProvider, (deps?: { readonly logger?: Logger }) => AgentDefinitionAdapter>> = {
  'claude-code': createClaudeAgentDefinitionAdapter,
  'github-copilot': createCopilotAgentDefinitionAdapter,
  'openai-codex': createCodexAgentDefinitionAdapter,
  opencode: createOpencodeAgentDefinitionAdapter,
};

export const createAgentDefinitionAdapter = (deps: AgentDefinitionAdapterFactoryDeps): AgentDefinitionAdapter => {
  const logger = deps.logger;
  return AGENT_ADAPTERS[deps.provider](logger !== undefined ? { logger } : undefined);
};
