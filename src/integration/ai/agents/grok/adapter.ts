/**
 * `createGrokAgentDefinitionAdapter` — {@link AgentDefinitionAdapter} for the Grok Build CLI
 * provider. Writes each definition to `<sessionDir>/.grok/agents/ralphctl-<name>.md`.
 *
 * Logic (project-wins, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemAgentDefinitionAdapter} — shared with the claude, codex, copilot and
 * opencode variants, which differ only in `parentDir`, `renderer`, and the convention text.
 */

import { createFilesystemAgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/filesystem-agent-definition-adapter.ts';
import { renderGrokAgent } from '@src/integration/ai/agents/_engine/render-grok-agent.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { PROVIDER_TRAITS } from '@src/integration/ai/providers/_engine/provider-traits.ts';

export interface CreateGrokAgentDefinitionAdapterDeps {
  readonly logger?: Logger;
}

const CONVENTION = [
  'Agent definitions live under `.grok/agents/<name>.md` in this repository. Each file starts',
  'with a YAML frontmatter block (`name`, `description`, optional `model`) followed by the',
  'markdown system prompt. Before drafting a new one, list `.grok/agents/` and read any file',
  'whose name or `description` overlaps the persona you need.',
].join(' ');

export const createGrokAgentDefinitionAdapter = (
  deps: CreateGrokAgentDefinitionAdapterDeps = {}
): AgentDefinitionAdapter =>
  createFilesystemAgentDefinitionAdapter({
    providerId: 'xai-grok',
    parentDir: PROVIDER_TRAITS['xai-grok'].agentsParentDir,
    renderer: renderGrokAgent,
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
