/**
 * `renderCodexAgent` — render an {@link AgentDefinition} into Codex's native agent format:
 * `.codex/agents/ralphctl-<name>.toml`, with `name` / `description` / `developer_instructions`
 * (the Markdown body) plus optional `model` / `model_reasoning_effort` keys.
 *
 * Values are encoded as TOML basic strings via `JSON.stringify` — TOML basic-string escaping
 * (`\"`, `\\`, `\n`, `\t`, …) is a compatible subset of JSON's, so this avoids hand-rolling an
 * escaper for a body that may contain arbitrary Markdown.
 */

import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition, RenderedAgentFile } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { RALPHCTL_AGENT_PREFIX } from '@src/integration/ai/agents/_engine/agent-definition.ts';

const tomlString = (value: string): string => JSON.stringify(value);

export const renderCodexAgent = (definition: AgentDefinition): Result<RenderedAgentFile, StorageError> => {
  const lines = [
    `name = ${tomlString(definition.name)}`,
    `description = ${tomlString(definition.description)}`,
    `developer_instructions = ${tomlString(definition.content.replace(/\s+$/u, ''))}`,
  ];
  if (definition.model !== undefined) lines.push(`model = ${tomlString(definition.model)}`);
  if (definition.effort !== undefined) lines.push(`model_reasoning_effort = ${tomlString(definition.effort)}`);

  const content = `${lines.join('\n')}\n`;
  const relPath = join('.codex', 'agents', `${RALPHCTL_AGENT_PREFIX}${definition.name}.toml`);
  return Result.ok({ relPath, content });
};
