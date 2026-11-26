/**
 * Shared agent-definition parsing helpers — the frontmatter split + YAML reader that every
 * agent-definition source backed by an on-disk Markdown file consumes.
 *
 * Agent definitions use the same YAML frontmatter as SKILL.md, so the split/YAML primitives live
 * in the shared `skills/_engine/frontmatter.ts` module, reached via the documented cross-concept
 * `_engine`-to-`_engine` import seam. The frontmatter is read as YAML (with the same tolerance for
 * an unquoted `: ` in a value) and then projected flat: only top-level scalars reach the schema.
 *
 * `parseAgentDefinition` validates against {@link AgentDefinitionFrontmatterSchema} and asserts
 * frontmatter `name` matches the source name. The `label` parameter tailors the error message
 * prefix so a caller can say "bundled agent X" vs "operator agent X".
 */

import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { AgentDefinitionFrontmatterSchema } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import {
  flattenFrontmatter,
  parseYamlFrontmatter,
  splitFrontmatter,
} from '@src/integration/ai/skills/_engine/frontmatter.ts';

/**
 * Parse an already-read agent-definition file body into the canonical {@link AgentDefinition}
 * record. Split from the read so a file-required path and an optional-file path can share the
 * frontmatter-validation tail. `label` prefixes the error message (`bundled agent` / `operator
 * agent`).
 */
export const parseAgentDefinition = (
  label: string,
  path: string,
  name: string,
  raw: string
): Result<AgentDefinition, StorageError> => {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseYamlFrontmatter(frontmatter);
  if (!fm.ok) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `${label} ${name}: frontmatter is not valid YAML (${fm.error})`,
        path,
      })
    );
  }
  const parsed = AgentDefinitionFrontmatterSchema.safeParse(flattenFrontmatter(fm.value));
  if (!parsed.success) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `${label} ${name}: invalid frontmatter (${parsed.error.message})`,
        path,
      })
    );
  }
  if (parsed.data.name !== name) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `${label} ${name}: frontmatter name '${parsed.data.name}' must match source name`,
        path,
      })
    );
  }
  return Result.ok({
    name: parsed.data.name,
    description: parsed.data.description,
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
    ...(parsed.data.effort !== undefined ? { effort: parsed.data.effort } : {}),
    content: body,
  });
};
