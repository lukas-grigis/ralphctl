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
