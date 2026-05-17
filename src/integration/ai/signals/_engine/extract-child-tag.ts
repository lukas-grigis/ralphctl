/**
 * Find the first `<tag>…</tag>` occurrence inside `body` and return the trimmed inner text.
 * Used by parsers that decode an outer signal with nested child tags (e.g. `<commit-message>`
 * wraps `<subject>` / `<body>`; `<progress-entry>` wraps `<task>` / `<files-changed>` / …).
 *
 * Returns `undefined` if the tag is absent so callers can distinguish "child missing" from
 * "child present but empty after trim." When present-but-empty matters, check the returned
 * string's length; when both should collapse, fall back with `?? ''`.
 *
 * Tag names are inlined into a regex — pass plain tag names (`'task'`, `'files-changed'`), not
 * caller-supplied input. No regex metachars in our signal vocabulary.
 */
export const extractChildTag = (body: string, tagName: string): string | undefined => {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const m = re.exec(body);
  if (m === null) return undefined;
  return (m[1] ?? '').trim();
};
