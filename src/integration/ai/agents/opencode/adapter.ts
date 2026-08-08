/**
 * `createOpencodeAgentDefinitionAdapter` — {@link AgentDefinitionAdapter} for the OpenCode
 * provider. Writes each definition to `<sessionDir>/.opencode/agents/ralphctl-<name>.md`,
 * OpenCode's project-level agent-definition path.
 *
 * Logic (project-wins, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemAgentDefinitionAdapter} — shared with the claude, codex and copilot
 * variants, which differ only in `parentDir`, `renderer`, and the convention text.
 */

import { createFilesystemAgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/filesystem-agent-definition-adapter.ts';
import { renderOpencodeAgent } from '@src/integration/ai/agents/_engine/render-opencode-agent.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';

export interface CreateOpencodeAgentDefinitionAdapterDeps {
  readonly logger?: Logger;
}

const CONVENTION = [
  'Agent definitions live under `.opencode/agents/<name>.md` in this repository. Each file starts',
  'with a YAML frontmatter block (`description`, `mode`, optional `model`) followed by the markdown',
  'system prompt — the agent name comes from the filename, not a frontmatter key. Before drafting',
  'a new one, list `.opencode/agents/` and read any file whose name or `description` overlaps the',
  'persona you need.',
].join(' ');

export const createOpencodeAgentDefinitionAdapter = (
  deps: CreateOpencodeAgentDefinitionAdapterDeps = {}
): AgentDefinitionAdapter =>
  createFilesystemAgentDefinitionAdapter({
    providerId: 'opencode',
    parentDir: PROVIDER_TRAITS.opencode.agentsParentDir,
    renderer: renderOpencodeAgent,
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
