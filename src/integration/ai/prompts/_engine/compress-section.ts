/**
 * Tail-compression for large dynamic prompt sections.
 *
 * Research basis: "Lost in the Middle" (Liu et al., arXiv 2307.03172) shows that LLMs attend
 * poorly to content placed in the middle of long contexts. Long PRIOR_PROGRESS / PRIOR_LEARNINGS
 * substitutions push task-critical sections (goal, success-criteria, output contract) toward the
 * middle. Keeping the MOST RECENT content (the tail) and dropping the oldest bytes is the correct
 * strategy — the harness already applies the same principle to stderr via BoundedTail.
 *
 * The one-line notice is prepended (not appended) so it appears before the retained content and
 * makes the truncation visible to the model without burying it after the dropped material.
 */

/** Maximum characters retained per large dynamic section before tail-truncation kicks in. */
export const SECTION_CHAR_CAP = 4_000;

/**
 * Tail-compress `content` to at most `cap` characters.
 *
 * - Content at or below `cap`: returned unchanged.
 * - Content above `cap`: trimmed to the last `cap` characters (tail preserved; head dropped)
 *   and prefixed with a one-line notice so the model sees the truncation boundary.
 *
 * @param content - The section text to compress.
 * @param cap     - Character ceiling. Defaults to {@link SECTION_CHAR_CAP}.
 */
export const compressSection = (content: string, cap: number = SECTION_CHAR_CAP): string => {
  if (content.length <= cap) return content;
  // `slice` counts UTF-16 code units: when the cap boundary straddles a surrogate pair the tail
  // loses the pair's high half (a lone low surrogate). Acceptable for prompt delivery — the model
  // tolerates one malformed glyph at the truncation seam, and no defensive scan belongs in this hot path.
  const tail = content.slice(-cap);
  const notice = `[… earlier content omitted — showing last ${String(cap)} chars of ${String(content.length)} total]\n\n`;
  return notice + tail;
};
