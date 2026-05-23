/**
 * Best-effort derivation of an `externalRef` short form (`#<number>`) from a
 * GitHub or GitLab issue URL. Returns `undefined` for shapes we don't
 * recognise — including pull-request / merge-request URLs, which are not
 * issues and shouldn't auto-close anything when referenced in a commit.
 *
 * Used by ticket creation paths (interactive add-loop, one-shot CLI add,
 * refine-create) so a ticket sourced from an issue URL automatically carries
 * the ref that the commit trailer + PR-body renderers consume — closing
 * `Ticket.externalRef === undefined` blind spots that left commits without a
 * `Closes #N` line.
 *
 * Format choice: short `#NN` (not `owner/repo#NN`). Same-repo close is the
 * dominant case for sprint work; users who need cross-repo refs can set
 * `externalRef` explicitly.
 *
 * Examples:
 *   `https://github.com/foo/bar/issues/42`            → `'#42'`
 *   `https://gitlab.com/grp/sub/proj/-/issues/7`      → `'#7'`
 *   `https://github.com/foo/bar/pull/42`              → `undefined`
 *   `https://example.com/anything`                    → `undefined`
 */
export const parseExternalRefFromUrl = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);

  // GitHub: /<owner>/<repo>/issues/<number>
  if (parsed.hostname.includes('github')) {
    if (segments.length >= 4 && segments[2] === 'issues') {
      const num = Number(segments[3]);
      if (Number.isInteger(num) && num > 0) return `#${String(num)}`;
    }
    return undefined;
  }

  // GitLab (incl. self-hosted): /<group...>/<project>/-/issues/<number>
  const dashIdx = segments.indexOf('-');
  if (dashIdx >= 2 && segments[dashIdx + 1] === 'issues') {
    const num = Number(segments[dashIdx + 2]);
    if (Number.isInteger(num) && num > 0) return `#${String(num)}`;
  }
  return undefined;
};

/**
 * Normalize a list of external tracker references (`Ticket.externalRef` /
 * `Task.externalRefs`): trim each entry, drop empties, dedupe first-seen-wins,
 * preserve input order.
 *
 * Shared between the commit-trailer renderer (integration) and the PR-body
 * renderer (business) so both layers agree on what counts as a "meaningful"
 * external reference. Pure — no I/O, no `node:*` imports.
 *
 * Examples:
 *   `['#123', '#123', '!456']`        → `['#123', '!456']`
 *   `['  PROJ-7  ', '', '\tPROJ-8']`  → `['PROJ-7', 'PROJ-8']`
 *   `undefined`                       → `[]`
 */
export const normalizeRefs = (refs: readonly string[] | undefined): readonly string[] => {
  if (refs === undefined || refs.length === 0) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const r of refs) {
    const trimmed = r.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
};
