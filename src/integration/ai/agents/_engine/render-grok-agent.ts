/**
 * `renderGrokAgent` — render an {@link AgentDefinition} into Grok Build CLI's native agent
 * format: `.grok/agents/ralphctl-<name>.md`, a YAML frontmatter block (`name`, `description`,
 * optional `model`) followed by the Markdown body used as the agent's system prompt.
 *
 * Grok ignores Claude-only keys (`permissionMode`, `effort`, `tools`); they are not emitted.
 *
 * Frontmatter scalars are emitted as YAML double-quoted strings via `JSON.stringify` — YAML's
 * double-quoted scalar escaping is a compatible subset of JSON's.
 */

import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition, RenderedAgentFile } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { namespacedAgentFileBase } from '@src/integration/ai/agents/_engine/agent-definition.ts';

const yamlString = (value: string): string => JSON.stringify(value);

export const renderGrokAgent = (definition: AgentDefinition): Result<RenderedAgentFile, StorageError> => {
  const lines = ['---', `name: ${yamlString(definition.name)}`, `description: ${yamlString(definition.description)}`];
  if (definition.model !== undefined) lines.push(`model: ${yamlString(definition.model)}`);
  lines.push('---');

  const content = `${lines.join('\n')}\n\n${definition.content.replace(/\s+$/u, '')}\n`;
  const relPath = join('.grok', 'agents', `${namespacedAgentFileBase(definition.name)}.md`);
  return Result.ok({ relPath, content });
};
