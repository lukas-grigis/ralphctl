/**
 * `renderCopilotAgent` — render an {@link AgentDefinition} into GitHub Copilot's native agent
 * format: `.github/agents/ralphctl-<name>.agent.md`, a YAML frontmatter block (`description`,
 * `name`, optional `model`) followed by the Markdown body.
 *
 * Copilot rejects an agent file whose body exceeds 30000 characters — the renderer enforces
 * that limit up front and returns a {@link StorageError} instead of producing a file the CLI
 * would refuse to load.
 */

import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition, RenderedAgentFile } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { RALPHCTL_AGENT_PREFIX } from '@src/integration/ai/agents/_engine/agent-definition.ts';

/** Copilot's documented per-agent body size limit. */
export const COPILOT_AGENT_MAX_BODY_CHARS = 30000;

export const renderCopilotAgent = (definition: AgentDefinition): Result<RenderedAgentFile, StorageError> => {
  const relPath = join('.github', 'agents', `${RALPHCTL_AGENT_PREFIX}${definition.name}.agent.md`);

  if (definition.content.length > COPILOT_AGENT_MAX_BODY_CHARS) {
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message: `copilot agent '${definition.name}': body is ${definition.content.length} chars, exceeds the ${COPILOT_AGENT_MAX_BODY_CHARS}-char Copilot agent size limit`,
        path: relPath,
      })
    );
  }

  const lines = ['---', `description: ${definition.description}`, `name: ${definition.name}`];
  if (definition.model !== undefined) lines.push(`model: ${definition.model}`);
  lines.push('---');

  const content = `${lines.join('\n')}\n\n${definition.content.replace(/\s+$/u, '')}\n`;
  return Result.ok({ relPath, content });
};
