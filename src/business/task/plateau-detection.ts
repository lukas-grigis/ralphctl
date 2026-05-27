import type { EvaluationSignal } from '@src/domain/signal.ts';

/**
 * Plateau detection for the gen-eval inner loop.
 *
 * A generator ↔ evaluator loop can converge on a local optimum where every iteration
 * produces the same critique. Feeding the generator yet another round is wasteful — it has
 * already failed this fix once and burned turns + tokens. The default heuristic flags two
 * consecutive evaluator turns reporting the identical set of failed dimensions and short-
 * circuits the loop.
 *
 * The default is too eager in two practical cases:
 *  1. The AI changed its proposed commit message between rounds. Concrete forward progress
 *     happened, even if the evaluator stayed unhappy. We soften to a warning (record it on
 *     the attempt for review) but let the loop keep going.
 *  2. The evaluator's *prose* shifted significantly even though the dimension names didn't.
 *     The complaint moved — that's progress, not a stuck loop.
 *
 * {@link computePlateauVerdict} encodes both exemptions. The original strict-equality
 * predicate ({@link dimensionsEqual}) is preserved for callers that only need the dimension-
 * set comparison.
 *
 * The score-improvement exemption (rubric-pre-redesign) is gone — the new PASS / FAIL rubric
 * has no numeric score to compare. Critique-shift is the sole positive progress signal.
 *
 * Pure. No I/O.
 */

/**
 * One per-turn record consumed by {@link computePlateauVerdict}. The evaluator leaf appends
 * a record at the end of every turn so the next evaluator turn can detect plateaus across
 * the configured threshold of consecutive turns.
 *
 * `commitSubject` is the generator's *proposed* commit-message subject from the same turn —
 * the harness commits once per attempt (outside the inner loop), so the generator's
 * `<commit-message>` signal is the only per-round proxy for "what would have been committed
 * if we stopped here." A change in `commitSubject` across turns is treated as forward progress.
 */
export interface PlateauTurnRecord {
  readonly evaluation: EvaluationSignal;
  readonly critique?: string;
  readonly commitSubject?: string;
}

/**
 * Outcome of the plateau predicate.
 *
 *   - `none`     — no plateau (not enough history, dimensions differ, or one of the
 *                  progress exemptions applies). The loop continues normally.
 *   - `progress` — same dimensions across threshold turns, but the critique prose shifted
 *                  enough. The loop continues; the evaluator's next turn decides.
 *   - `warning`  — same dimensions across threshold turns AND the AI's proposed commit
 *                  subject changed between turns. The harness records a `plateau` warning
 *                  on the attempt but does NOT exit the loop yet.
 *   - `plateau`  — same dimensions across threshold turns and none of the exemptions
 *                  applied. The loop exits; finalize-gen-eval transitions the task to
 *                  `done` with a `plateau` warning.
 */
export type PlateauVerdict =
  | { readonly kind: 'none' }
  | { readonly kind: 'progress'; readonly reason: 'critique-shifted' }
  | { readonly kind: 'warning'; readonly dimensions: readonly string[]; readonly reason: 'commit-progress' }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[] };

export interface PlateauOptions {
  /**
   * Number of consecutive turns flagging the same dimension set before plateau fires.
   * Validated as 2–5 by the settings schema; the predicate clamps defensively so a
   * misconfigured caller doesn't crash the loop.
   */
  readonly threshold: number;
}

/**
 * Extract the set of failed dimension names from a parsed evaluation. Names are lowercased
 * and trimmed so `Correctness` / ` correctness ` / `CORRECTNESS` collapse to one entry.
 */
export const failedDimensions = (signal: EvaluationSignal): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const d of signal.dimensions) {
    if (!d.passed) {
      names.add(d.dimension.trim().toLowerCase());
    }
  }
  return names;
};

/**
 * Two evaluation signals plateau when their sets of failed dimensions are identical AND
 * non-empty. Empty sets return `false` — a result with no failures couldn't have driven us
 * into the fix loop, and we shouldn't treat "no failures detected" as a stable plateau.
 */
export const dimensionsEqual = (prev: EvaluationSignal, curr: EvaluationSignal): boolean => {
  const a = failedDimensions(prev);
  const b = failedDimensions(curr);
  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return false;
  for (const name of a) {
    if (!b.has(name)) return false;
  }
  return true;
};

/** True when both sets are non-empty and contain exactly the same elements. */
const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return false;
  for (const name of a) {
    if (!b.has(name)) return false;
  }
  return true;
};

/**
 * Trigram set for Jaccard similarity. Whitespace is collapsed to a single space so
 * formatting tweaks don't drop similarity, then we slide a 3-char window across the
 * normalised string. Strings shorter than 3 chars produce a single-element set containing
 * themselves so similarity stays defined.
 */
const trigrams = (text: string): ReadonlySet<string> => {
  const normalised = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalised.length < 3) return new Set([normalised]);
  const grams = new Set<string>();
  for (let i = 0; i <= normalised.length - 3; i += 1) {
    grams.add(normalised.slice(i, i + 3));
  }
  return grams;
};

/**
 * Jaccard similarity over character trigrams in `[0, 1]`. Two identical strings return `1`;
 * two strings sharing no trigrams return `0`. Cheap by construction — both inputs are
 * already short (one critique paragraph each).
 */
export const trigramJaccard = (a: string, b: string): number => {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let intersection = 0;
  for (const g of ta) {
    if (tb.has(g)) intersection += 1;
  }
  const union = ta.size + tb.size - intersection;
  if (union === 0) return 1;
  return intersection / union;
};

/** Critique-shift threshold; similarity strictly below this counts as a meaningful change. */
const CRITIQUE_SHIFT_SIMILARITY = 0.5;

/**
 * Compute whether the just-completed evaluator turn (`current`) plateaus relative to the
 * previous `priorTurns`. See {@link PlateauVerdict} for the exit-decision taxonomy and the
 * exemption rules.
 *
 * Pure. The caller wires the threshold from `settings.harness.plateauThreshold`.
 */
export const computePlateauVerdict = (
  priorTurns: readonly PlateauTurnRecord[],
  current: PlateauTurnRecord,
  options: PlateauOptions
): PlateauVerdict => {
  // Defensive clamp: schema enforces 2–5, but the predicate is the load-bearing path —
  // a bad config value shouldn't be able to crash the inner loop.
  const threshold = Math.max(2, Math.min(5, Math.trunc(options.threshold)));

  // Not enough history to plateau yet.
  if (priorTurns.length < threshold - 1) return { kind: 'none' };

  // Look at the last `threshold - 1` prior turns + current — every one must report the
  // same non-empty set of failed dimensions for the plateau predicate to fire.
  const window = priorTurns.slice(-(threshold - 1));
  const currentFailed = failedDimensions(current.evaluation);
  if (currentFailed.size === 0) return { kind: 'none' };
  for (const turn of window) {
    if (!setsEqual(failedDimensions(turn.evaluation), currentFailed)) return { kind: 'none' };
  }

  // The dimensions agree across the window. Now check the exemptions, comparing against
  // the most-recent prior turn — the AI's last observable behaviour is what matters.
  const lastPrior = window[window.length - 1];
  // The slice above guarantees window has at least one entry when we reach this point.
  if (lastPrior === undefined) return { kind: 'none' };

  const priorCritique = lastPrior.critique;
  const currentCritique = current.critique;
  if (
    priorCritique !== undefined &&
    priorCritique.trim().length > 0 &&
    currentCritique !== undefined &&
    currentCritique.trim().length > 0 &&
    trigramJaccard(priorCritique, currentCritique) < CRITIQUE_SHIFT_SIMILARITY
  ) {
    return { kind: 'progress', reason: 'critique-shifted' };
  }

  const dimensions = [...currentFailed];

  // A non-empty commit-subject change between rounds is *real* AI progress even if the
  // evaluator stayed unhappy. Soften the plateau to a warning so the loop continues; the
  // attempt still carries the structured `plateau` warning for operator review.
  const priorSubject = lastPrior.commitSubject;
  const currentSubject = current.commitSubject;
  if (
    priorSubject !== undefined &&
    priorSubject.trim().length > 0 &&
    currentSubject !== undefined &&
    currentSubject.trim().length > 0 &&
    priorSubject.trim() !== currentSubject.trim()
  ) {
    return { kind: 'warning', dimensions, reason: 'commit-progress' };
  }

  return { kind: 'plateau', dimensions };
};
