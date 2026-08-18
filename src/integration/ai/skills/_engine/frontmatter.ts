/**
 * Shared flat-frontmatter parsing primitives — the frontmatter split + naive-YAML reader that
 * every Markdown-with-frontmatter format this codebase reads is built on: SKILL.md
 * (`./parse-skill.ts`'s `parseSkill`) and agent-definition Markdown
 * (`agents/_engine/parse-agent-definition.ts`'s `parseAgentDefinition`). Both formats use the
 * identical flat `key: value` frontmatter shape, so one implementation serves both — a real
 * YAML lib lands only when either format needs nested / multiline frontmatter.
 *
 * Lives under `skills/_engine/` (rather than a new top-level `integration/ai/_engine/`) so the
 * existing cross-concept `_engine`-to-`_engine` import seam applies unchanged: `agents/_engine/`
 * reaches in here exactly the way `readiness/_engine/` already reaches into `providers/_engine/`
 * and `prompts/_engine/`.
 */

/**
 * Split a frontmatter-fenced Markdown file body into frontmatter + content. The frontmatter
 * block is the first `---` … `---` pair starting at the file's first non-whitespace line;
 * everything after the closing fence is the body. Returns the body verbatim when no frontmatter
 * is present — callers then validate frontmatter separately.
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
 * Naive YAML key:value parser — keys are simple identifiers, values are plain strings,
 * double-quoted strings with `\"` / `\\` escapes (the shape the skills adapter's renderer
 * emits for values a strict YAML parser would reject unquoted), or single-quoted strings
 * without escapes. Frontmatter we control is always this shape, so a full YAML parser is
 * overkill (and adds a dep). Multiline / nested YAML is rejected via schema validation.
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
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1).replace(/\\(["\\])/gu, '$1');
    else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
};

/** Narrow an unknown caught value to a Node `fs` error code without leaking `any`. @public */
export const errorCode = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;
