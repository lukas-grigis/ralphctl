/**
 * Trim + dedupe a per-attempt signal-text accumulator (changes / decisions / notes), preserving
 * first-seen order. Entries that are empty / whitespace-only after trimming are dropped; a later
 * duplicate of an already-seen trimmed text is discarded. Undefined / empty input resolves to an
 * empty array — callers never need an `?? []` guard.
 *
 * Shared by the progress-journal and append-learnings leaves (both leaves fold their own
 * change/decision/note accumulators through this exact contract before rendering / persisting).
 */
export const dedupeTexts = (texts: readonly string[] | undefined): readonly string[] => {
  if (texts === undefined || texts.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of texts) {
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};
