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
 * Backstop cap for sections whose PRODUCER already applies its own window-scaled, section-aware
 * cap before substitution — `capProgressBody` for `PRIOR_PROGRESS` (via `progressCapBudgetForModel`
 * in `application/flows/_shared/progress/cap-progress.ts`), `composePriorLearnings` for
 * `PRIOR_LEARNINGS`. Those producers put the highest-value content at the HEAD (sprint state
 * header, pinned lifecycle breadcrumbs, elision notes, the current task's full attempt history —
 * the "depth guarantee") and bound breadth with a token budget scaled to the resolved model's
 * context window (up to ~1M tokens today). The blunt `SECTION_CHAR_CAP` tail-slice is far smaller
 * than that budget and keeps the TAIL, so applying it on top of an already-capped value silently
 * destroyed the producer's careful head-first prioritisation.
 *
 * This constant is sized to the LARGEST legitimate pre-capped output — the biggest known context
 * window's sibling budget, in characters, plus a generous allowance for the unbudgeted header band
 * and current-task depth guarantee — so it never fires against a well-behaved producer. It exists
 * ONLY as catastrophic-overflow insurance for a future producer that forgets to pre-cap; when it
 * does fire, the existing tail-slice + notice semantics still apply (true overflow only).
 *
 * `200_000 = round(1_000_000 * 0.04) tokens * 4 chars/token + 40_000` — mirrors the arithmetic in
 * `progressCapBudgetForModel` (`PROGRESS_BUDGET_FRACTION` * `CHARS_PER_TOKEN`) against
 * `MAX_CONTEXT_WINDOW` (`domain/value/settings-models/context-window.ts`), plus a 40,000-char depth
 * allowance. A drift-fence test recomputes this from the live catalog and fails if a bigger context
 * window ever ships without raising this cap.
 */
export const PRECAPPED_SECTION_CHAR_CAP = 200_000;

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
