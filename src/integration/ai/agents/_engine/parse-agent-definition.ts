/**
 * Shared agent-definition parsing helpers — the frontmatter split + naive-YAML reader that
 * every agent-definition source backed by an on-disk Markdown file consumes.
 *
 * Reuses the same flat `key: value` frontmatter shape as SKILL.md — a real YAML lib lands only
 * when an agent definition needs nested / multiline frontmatter.
 *
 * `parseAgentDefinition` validates against {@link AgentDefinitionFrontmatterSchema} and asserts
 * frontmatter `name` matches the source name. The `label` parameter tailors the error message
 * prefix so a caller can say "bundled agent X" vs "operator agent X".
 */

import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AgentDefinition } from '@src/integration/ai/agents/_engine/agent-definition.ts';
import { AgentDefinitionFrontmatterSchema } from '@src/integration/ai/agents/_engine/agent-definition.ts';

/**
 * Split an agent-definition file body into frontmatter + content. The frontmatter block is the
 * first `---` … `---` pair starting at the file's first non-whitespace line; everything after
 * the closing fence is the body. Returns the body verbatim when no frontmatter is present —
 * callers then validate frontmatter separately.
 *
 * @public
 */
export const splitFrontmatter = (raw: string): { readonly frontmatter: string; readonly body: string } => {
  const trimmed = raw.replace(/^\uFEFF/u, ''); // strip UTF-8 BOM
  if (!trimmed.startsWith('---')) return { frontmatter: '', body: trimmed };
  const closing = trimmed.indexOf('\n---', 3);
  if (closing === -1) return { frontmatter: '', body: trimmed };
  const frontmatter = trimmed.slice(3, closing).trim();
  const afterClose = trimmed.slice(closing + 4); // skip "\n---"
  // Strip every blank line after the closing fence so the body is clean. Stripping only ONE
  // line-end would keep the standard blank separator line inside the body, and each
  // parse → render round-trip (render re-inserts the separator) would grow the file by one
  // blank line.
  const body = afterClose.replace(/^(?:\r?\n)+/, '');
  return { frontmatter, body };
};

/**
 * Naive YAML key:value parser — keys are simple identifiers, values are strings or single-quoted
 * strings without escapes. Frontmatter we control is always this shape, so a full YAML parser
 * is overkill (and adds a dep). Multiline / nested YAML is rejected via schema validation.
 *
 * @public
 */
export const parseSimpleYaml = (input: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const stripped = line.trim();
    if (stripped.length === 0 || stripped.startsWith('#')) continue;
    const colon = stripped.indexOf(':');
    if (colon === -1) continue;
    const key = stripped.slice(0, colon).trim();
    let value = stripped.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
};

/** Narrow an unknown caught value to a Node `fs` error code without leaking `any`. @public */
export const errorCode = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;

/**
 * Parse an already-read agent-definition file body into the canonical {@link AgentDefinition}
 * record. Split from the read so a file-required path and an optional-file path can share the
 * frontmatter-validation tail. `label` prefixes the error message (`bundled agent` / `operator
 * agent`).
 *
 * @public
 */
export const parseAgentDefinition = (
  label: string,
  path: string,
  name: string,
  raw: string
): Result<AgentDefinition, StorageError> => {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseSimpleYaml(frontmatter);
  const parsed = AgentDefinitionFrontmatterSchema.safeParse(fm);
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
