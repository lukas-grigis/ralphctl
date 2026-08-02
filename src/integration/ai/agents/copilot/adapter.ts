/**
 * `createCopilotAgentDefinitionAdapter` — {@link AgentDefinitionAdapter} for the GitHub Copilot
 * provider. Writes each definition to `<sessionDir>/.github/agents/ralphctl-<name>.agent.md`,
 * Copilot's documented custom-agent path.
 *
 * Logic (project-wins, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemAgentDefinitionAdapter} — shared with the claude and codex variants.
 * The 30000-char body size guard lives in {@link renderCopilotAgent}.
 */

import { createFilesystemAgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/filesystem-agent-definition-adapter.ts';
import { renderCopilotAgent } from '@src/integration/ai/agents/_engine/render-copilot-agent.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';

export interface CreateCopilotAgentDefinitionAdapterDeps {
  readonly logger?: Logger;
}

const CONVENTION = [
  'Agent definitions live under `.github/agents/<name>.agent.md` in this repository. Each file',
  'starts with a YAML frontmatter block (`description`, `name`, optional `model`) followed by',
  'the markdown system prompt. Before drafting a new one, list `.github/agents/` and read any',
  'file whose `name` or `description` overlaps the persona you need. Bodies over 30000',
  'characters are rejected — keep the system prompt focused.',
].join(' ');

export const createCopilotAgentDefinitionAdapter = (
  deps: CreateCopilotAgentDefinitionAdapterDeps = {}
): AgentDefinitionAdapter =>
  createFilesystemAgentDefinitionAdapter({
    providerId: 'github-copilot',
    parentDir: PROVIDER_TRAITS['github-copilot'].agentsParentDir,
    renderer: renderCopilotAgent,
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
