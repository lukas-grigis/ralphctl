/**
 * `createClaudeAgentDefinitionAdapter` — {@link AgentDefinitionAdapter} for the Claude Code
 * provider. Writes each definition to `<sessionDir>/.claude/agents/ralphctl-<name>.md` so the
 * running `claude` CLI auto-discovers it as a sub-agent.
 *
 * Logic (project-wins, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemAgentDefinitionAdapter} — Claude shares it with the codex and copilot
 * agent-definition adapters, which only differ in `parentDir`, `renderer`, and the convention
 * text.
 */

import { createFilesystemAgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/filesystem-agent-definition-adapter.ts';
import { renderClaudeAgent } from '@src/integration/ai/agents/_engine/render-claude-agent.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';

export interface CreateClaudeAgentDefinitionAdapterDeps {
  readonly logger?: Logger;
}

const CONVENTION = [
  'Agent definitions live under `.claude/agents/<name>.md` in this repository. Each file starts',
  'with a YAML frontmatter block (`name`, `description`, optional `model` / `effort`) followed',
  'by the markdown system prompt. Before drafting a new one, list `.claude/agents/` and read',
  'any file whose `name` or `description` overlaps the persona you need.',
].join(' ');

export const createClaudeAgentDefinitionAdapter = (
  deps: CreateClaudeAgentDefinitionAdapterDeps = {}
): AgentDefinitionAdapter =>
  createFilesystemAgentDefinitionAdapter({
    providerId: 'claude-code',
    parentDir: PROVIDER_TRAITS['claude-code'].agentsParentDir,
    renderer: renderClaudeAgent,
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
