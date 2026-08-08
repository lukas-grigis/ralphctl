/**
 * `renderOpencodeAgent` — render an {@link AgentDefinition} into OpenCode's native agent format:
 * `.opencode/agents/ralphctl-<name>.md`, a YAML frontmatter block followed by the Markdown body
 * used as the agent's system prompt.
 *
 * Two differences from the Claude renderer, both driven by OpenCode's schema:
 *
 *   - There is no `name` frontmatter key. OpenCode derives the agent name from the FILENAME, so
 *     emitting `name:` would be an ignored-unknown-field at best. The namespaced file base is
 *     therefore the only carrier of the name, exactly as `namespacedAgentFileBase` produces it.
 *   - `mode: subagent` is emitted explicitly. OpenCode's default mode makes an agent selectable
 *     as a PRIMARY agent in the TUI, which would put harness-installed personas in the operator's
 *     top-level picker; `subagent` keeps them delegation-only, matching how the claude / codex
 *     adapters' definitions behave.
 *
 * `effort` has no OpenCode frontmatter equivalent (the CLI spells it `--variant` at invocation
 * time, not per-agent), so it is deliberately dropped rather than emitted as a dead key.
 *
 * Frontmatter scalars are emitted as YAML double-quoted strings via `JSON.stringify` — YAML's
 * double-quoted scalar escaping is a compatible subset of JSON's.
 *
 * Docs: https://opencode.ai/docs/agents/
 */

import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition, RenderedAgentFile } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { namespacedAgentFileBase } from '@src/integration/ai/agents/_engine/agent-definition.ts';

const yamlString = (value: string): string => JSON.stringify(value);

export const renderOpencodeAgent = (definition: AgentDefinition): Result<RenderedAgentFile, StorageError> => {
  const lines = ['---', `description: ${yamlString(definition.description)}`, 'mode: subagent'];
  if (definition.model !== undefined) lines.push(`model: ${yamlString(definition.model)}`);
  lines.push('---');

  const content = `${lines.join('\n')}\n\n${definition.content.replace(/\s+$/u, '')}\n`;
  const relPath = join('.opencode', 'agents', `${namespacedAgentFileBase(definition.name)}.md`);
  return Result.ok({ relPath, content });
};
