/**
 * Extract every `{{PLACEHOLDER}}` token name from a template body. Returns the deduplicated
 * names in first-seen order. Used by completeness tests to assert that the template's
 * placeholders match the definition's `parameters` + `partials` keys exactly.
 */
export const extractPlaceholders = (template: string): readonly string[] => {
  const PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
  const seen = new Set<string>();
  const ordered: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = PATTERN.exec(template)) !== null) {
    const name = m[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
};
