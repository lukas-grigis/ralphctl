/**
 * Anchored windowing for variable-height list columns.
 *
 * The Execute view renders three stacked/side-by-side lists — Flow steps, Tasks, Recent log.
 * Flow steps and Recent log already bound their height (StepTrace anchors a running-row window;
 * RecentEventsTail tails `slice(-maxRows)`). The Tasks column was the lone holdout: it mapped
 * the entire task array, so an expanded active card plus a growing tail of settled cards summed
 * to an unbounded intrinsic height that pushed Recent log + footer off-screen once 3-4 tasks
 * were in flight.
 *
 * This is the shared primitive that closes the gap: given a list `total`, an `anchorIndex` (the
 * item that must stay visible — for Tasks, the active / focused card), and a `capCount` budget
 * (cards that fit, derived from terminal rows), it returns the slice bounds plus how many items
 * are hidden off each edge so the caller can render an "N more" cue. We count ITEMS, not
 * measured rows — consistent with the rail's card-counting and far simpler than Ink
 * `measureElement`; an exact row budget buys little when cards are variable-height.
 *
 * Pure and stateless: the window is derived from its inputs every render, so it never jitters on
 * an unrelated re-render (the anchor only moves when the active card advances or the user
 * navigates). When `capCount >= total` (or `capCount <= 0`) the full range is returned with no
 * hidden items, so an unbounded caller is a transparent no-op.
 */
export interface AnchoredWindow {
  /** Inclusive start index of the visible slice. */
  readonly start: number;
  /** Exclusive end index of the visible slice. */
  readonly end: number;
  /** Count of items hidden before `start` (drives a "▴ N more above" cue). */
  readonly hiddenBefore: number;
  /** Count of items hidden at / after `end` (drives a "▾ N more below" cue). */
  readonly hiddenAfter: number;
}

/**
 * Compute the visible slice of a list, keeping `anchorIndex` inside the window and clamping the
 * window to the list bounds. The window is centred on the anchor, then shifted so it never runs
 * off either edge (so the last page shows a full `capCount` items rather than a short tail).
 */
export const computeAnchoredWindow = (total: number, anchorIndex: number, capCount: number): AnchoredWindow => {
  if (total <= 0) return { start: 0, end: 0, hiddenBefore: 0, hiddenAfter: 0 };
  // No budget, or the whole list fits — show everything, hide nothing.
  if (capCount <= 0 || capCount >= total) {
    return { start: 0, end: total, hiddenBefore: 0, hiddenAfter: 0 };
  }
  // Clamp the anchor into range so a stale / -1 cursor can't push the window out of bounds.
  const safeAnchor = anchorIndex < 0 ? 0 : anchorIndex >= total ? total - 1 : anchorIndex;
  const half = Math.floor(capCount / 2);
  // Centre on the anchor, then clamp the start to [0, total - capCount].
  let start = safeAnchor - half;
  if (start < 0) start = 0;
  const maxStart = total - capCount;
  if (start > maxStart) start = maxStart;
  const end = start + capCount;
  return { start, end, hiddenBefore: start, hiddenAfter: total - end };
};
