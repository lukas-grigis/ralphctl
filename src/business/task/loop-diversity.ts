import { detectRepetitiveLoop } from '@src/business/task/escalation-policy.ts';

/**
 * Loop-diversity tracker — detects when the gen-eval inner loop is repeating the same failure
 * fingerprint across consecutive turns. A gen-eval loop that re-emits the identical
 * failed-dimension fingerprint round after round has plateaued; detecting that repetition is a
 * more reliable break signal than waiting out the turn budget.
 *
 * Thin stateful wrapper over the canonical {@link detectRepetitiveLoop} predicate in
 * escalation-policy.ts — there is ONE repetition predicate; this tracker only owns the bounded
 * rolling buffer of fingerprints.
 *
 * Pure. No I/O, no side effects.
 */
interface LoopDiversityTracker {
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
      // ONE canonical predicate: `detectRepetitiveLoop` returns `true` when the tail is
      // repetitive, so diversity is its negation. It already returns `false` on insufficient
      // history (< windowSize), so a short buffer reads as diverse.
      return !detectRepetitiveLoop(history, effective);
    },
  };
};
