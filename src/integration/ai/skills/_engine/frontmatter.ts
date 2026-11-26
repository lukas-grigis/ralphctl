/**
 * Shared frontmatter parsing primitives — the frontmatter split + YAML reader that
 * every Markdown-with-frontmatter format this codebase reads is built on: SKILL.md
 * (`./parse-skill.ts`'s `parseSkill`) and agent-definition Markdown
 * (`agents/_engine/parse-agent-definition.ts`'s `parseAgentDefinition`). Both formats use the
 * same YAML frontmatter, so one real YAML parser (the `yaml` package) serves both.
 *
 * Lives under `skills/_engine/` (rather than a new top-level `integration/ai/_engine/`) so the
 * existing cross-concept `_engine`-to-`_engine` import seam applies unchanged: `agents/_engine/`
 * reaches in here exactly the way `readiness/_engine/` already reaches into `providers/_engine/`
 * and `prompts/_engine/`.
 */

import { parse } from 'yaml';
import { Result } from '@src/domain/result.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';

/**
 * Split a frontmatter-fenced Markdown file body into frontmatter + content. The frontmatter
 * block is the first `---` … `---` pair starting at the file's first non-whitespace line;
 * everything after the closing fence is the body. Returns the body verbatim when no frontmatter
 * is present — callers then validate frontmatter separately.
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

/** A parsed frontmatter block: the top-level YAML map, values left as YAML typed them. */
export type FrontmatterMap = Readonly<Record<string, unknown>>;

const parseStrict = (input: string): Result<unknown, string> => {
  try {
    return Result.ok(parse(input, { uniqueKeys: true, strict: true }));
  } catch (cause) {
    return Result.error(messageOf(cause));
  }
};

const BLOCK_OR_FLOW_START = /^["'|>[{]/u;

/**
 * Published skills and agents often write `description: Use when: X` — invalid YAML (a nested
 * mapping in a plain scalar) that the CLIs loading them accept anyway. Quote each single-line,
 * top-level plain value that does not parse on its own, so that one value reads as the string the
 * author meant while every other key keeps its YAML type.
 */
const quoteUnparseableTopLevelValues = (input: string): string => {
  const lines = input.split('\n');
  return lines
    .map((line, i) => {
      const match = /^(?<key>[^\s#-][^:]*):[ \t]+(?<value>\S.*?)\s*$/u.exec(line);
      const value = match?.groups?.['value'];
      if (match === null || value === undefined || BLOCK_OR_FLOW_START.test(value)) return line;
      // An indented next line continues a multi-line plain scalar; quoting one line would break it.
      if (/^\s+\S/u.test(lines[i + 1] ?? '')) return line;
      if (parseStrict(`k: ${value}`).ok) return line;
      return `${match.groups?.['key'] ?? ''}: ${JSON.stringify(value)}`;
    })
    .join('\n');
};

/**
 * Parse a frontmatter block as YAML 1.2 (core schema): folded / literal scalars, nested maps
 * (`metadata`), lists and typed scalars all read the way the downstream CLIs read them. A top-level
 * value with an unquoted `: ` is read as its string (see {@link quoteUnparseableTopLevelValues}).
 * Duplicate keys, any other syntax error, or a document that is not a map are rejected with the
 * parser's message. Empty frontmatter is an empty map.
 */
export const parseYamlFrontmatter = (input: string): Result<FrontmatterMap, string> => {
  let parsed = parseStrict(input);
  if (!parsed.ok) {
    const lenient = parseStrict(quoteUnparseableTopLevelValues(input));
    if (lenient.ok) parsed = lenient;
  }
  if (!parsed.ok) return Result.error(parsed.error);
  const data = parsed.value;
  if (data === null || data === undefined) return Result.ok({});
  if (typeof data !== 'object' || Array.isArray(data)) return Result.error('frontmatter is not a key: value map');
  return Result.ok(data as FrontmatterMap);
};

/**
 * Flat string projection of a parsed frontmatter map for flat-schema consumers (agent
 * definitions): top-level scalars become strings; nested values are dropped so they can't stand in
 * for a top-level key.
 */
export const flattenFrontmatter = (map: FrontmatterMap): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'string') result[key] = value.replace(/\n$/u, '');
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = String(value);
  }
  return result;
};
