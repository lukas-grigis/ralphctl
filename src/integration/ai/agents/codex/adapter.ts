/**
 * `createCodexAgentDefinitionAdapter` — {@link AgentDefinitionAdapter} for the OpenAI Codex
 * provider. Writes each definition to `<sessionDir>/.codex/agents/ralphctl-<name>.toml`,
 * Codex's native TOML agent-definition path.
 *
 * Logic (project-wins, manifest-tracked uninstall, idempotent install) lives in
 * {@link createFilesystemAgentDefinitionAdapter} — shared with the claude and copilot variants.
 */

import { createFilesystemAgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/filesystem-agent-definition-adapter.ts';
import { renderCodexAgent } from '@src/integration/ai/agents/_engine/render-codex-agent.ts';
import type { AgentDefinitionAdapter } from '@src/integration/ai/agents/_engine/agent-definition-adapter.ts';
import type { Logger } from '@src/business/observability/logger.ts';

export interface CreateCodexAgentDefinitionAdapterDeps {
  readonly logger?: Logger;
}

const CONVENTION = [
  'Agent definitions live under `.codex/agents/<name>.toml` in this repository. Each file has',
  '`name`, `description`, and `developer_instructions` keys (the system prompt), plus optional',
  '`model` / `model_reasoning_effort`. Before drafting a new one, list `.codex/agents/` and read',
  'any file whose `name` or `description` overlaps the persona you need.',
].join(' ');

export const createCodexAgentDefinitionAdapter = (
  deps: CreateCodexAgentDefinitionAdapterDeps = {}
): AgentDefinitionAdapter =>
  createFilesystemAgentDefinitionAdapter({
    providerId: 'openai-codex',
    parentDir: '.codex',
    renderer: renderCodexAgent,
    convention: CONVENTION,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
