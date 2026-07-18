/**
 * `renderClaudeAgent` — render an {@link AgentDefinition} into Claude Code's native sub-agent
 * format: `.claude/agents/ralphctl-<name>.md`, a YAML frontmatter block (`name`, `description`,
 * optional `model` / `effort`) followed by the Markdown body used as the sub-agent's system
 * prompt.
 *
 * Frontmatter scalars are emitted as YAML double-quoted strings via `JSON.stringify` — YAML's
 * double-quoted scalar escaping (`\"`, `\\`, `\n`, `\t`, …) is a compatible subset of JSON's.
 */

import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition, RenderedAgentFile } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { namespacedAgentFileBase } from '@src/integration/ai/agents/_engine/agent-definition.ts';

const yamlString = (value: string): string => JSON.stringify(value);

export const renderClaudeAgent = (definition: AgentDefinition): Result<RenderedAgentFile, StorageError> => {
  const lines = ['---', `name: ${yamlString(definition.name)}`, `description: ${yamlString(definition.description)}`];
  if (definition.model !== undefined) lines.push(`model: ${yamlString(definition.model)}`);
  if (definition.effort !== undefined) lines.push(`effort: ${yamlString(definition.effort)}`);
  lines.push('---');

  const content = `${lines.join('\n')}\n\n${definition.content.replace(/\s+$/u, '')}\n`;
  const relPath = join('.claude', 'agents', `${namespacedAgentFileBase(definition.name)}.md`);
  return Result.ok({ relPath, content });
};
