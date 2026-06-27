/**
 * Loop-diversity guard — detects when the gen-eval inner loop is repeating the same failure
 * fingerprint across consecutive turns (low action diversity), a leading indicator of
 * algorithmic stasis. Based on TIDE (arXiv 2602.02196): plateaus stem from recursive looping
 * on the same error repeated, not reasoning incapacity; low action diversity is the reliable
 * break condition.
 *
 * Pure. No I/O, no side effects.
 */

export interface LoopDiversityTracker {
  /** Record a fingerprint for the current iteration. */
  record(fingerprint: string): void;
  /**
   * Returns `false` when the last `windowSize` fingerprints are all identical — the loop is
   * repeating the exact same failure pattern and diversity has collapsed.
   * Returns `true` when there is insufficient history or the tail is diverse.
   */
  isDiverse(): boolean;
}

/**
 * Create a loop-diversity tracker backed by a bounded rolling buffer.
 *
 * Maintains the last `windowSize * 2` fingerprints at most, capped on every `record` call so
 * the buffer never grows unboundedly across a long run.
 *
 * @param windowSize - Number of consecutive identical fingerprints that constitute a non-diverse
 *   loop. Clamped to ≥ 2 defensively.
 */
export const createLoopDiversityTracker = (windowSize = 3): LoopDiversityTracker => {
  const effective = Math.max(2, Math.trunc(windowSize));
  const history: string[] = [];

  return {
    record(fingerprint: string): void {
      history.push(fingerprint);
      // Bound the buffer to windowSize * 2 to prevent unbounded growth.
      if (history.length > effective * 2) {
        history.splice(0, history.length - effective * 2);
      }
    },
    isDiverse(): boolean {
      if (history.length < effective) return true;
      const tail = history.slice(-effective);
      const first = tail[0];
      return !tail.every((f) => f === first);
    },
  };
};
