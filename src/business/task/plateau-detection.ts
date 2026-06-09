import type { EvaluationSignal } from '@src/domain/signal.ts';

/**
 * Plateau detection for the gen-eval inner loop.
 *
 * A generator ↔ evaluator loop can converge on a local optimum where every iteration burns
 * turns + tokens without converging. Feeding the generator yet another round is wasteful. The
 * predicate flags a window of consecutive evaluator turns that made no *net* progress and
 * short-circuits the loop.
 *
 * ## What counts as a stall (the net-progress predicate)
 *
 * The window stalls when the failed-dimension COUNT never decreased across the window AND the
 * current turn still has failures. This is stricter than the old identical-set check in the
 * directions that matter and looser where it was over-eager:
 *
 *  - Identical failed sets across the window  → count constant       → stall (legacy behaviour).
 *  - Oscillating members at the SAME count    → count constant       → stall. The old check
 *    required an IDENTICAL set, so an alternating set ({A,B}→{B,C}→{A,C}) never plateaued and
 *    the loop ran to the turn budget. Measuring the count instead catches the flip-flop.
 *  - A growing failure set                    → count non-decreasing → stall (regressing, not progressing).
 *  - A turn whose failure count DROPS          → real progress        → NOT a stall (returns `none`).
 *  - The current turn has zero failures        → real progress        → NOT a stall.
 *
 * Rationale for "non-decreasing count" over "per-dimension streak": a streak on one specific
 * dimension would let the loop churn forever as long as ONE dimension keeps flipping in and out;
 * the count predicate treats any failed-set that isn't shrinking as a stall once the window
 * fills, which is the operator-facing definition of "stuck."
 *
 * ## Progress exemptions (only consulted once a stall is detected)
 *
 *  1. **Critique shift** — the evaluator's *prose* moved materially (trigram-Jaccard below the
 *     threshold) versus the MOST-DISSIMILAR prior turn in the window. Comparing against the max
 *     similarity over ALL priors (not just the immediate prior) defeats A/B/A critique
 *     alternation, where each turn looked novel next to its neighbour but recycled an earlier
 *     turn's complaint. The complaint genuinely moved → `progress`, loop continues.
 *  2. **Work-product change** — the per-turn `changedFilesHash` (a content fingerprint of the
 *     working tree the evaluator leaf computes harness-side) differs from every prior turn in
 *     the window. The AI actually changed the code, not just the commit message → `warning`,
 *     loop continues but the attempt records the soft signal. Identical fingerprints across the
 *     window defeat the exemption regardless of commit-message rewording — an LLM rewording the
 *     subject line with no code change no longer softens the plateau. Falls back to the
 *     commit-subject proxy ONLY when no fingerprint is present (older in-flight records).
 *
 * ## Warning cap
 *
 * Each per-turn record carries the {@link PlateauVerdict} kind the predicate assigned it. After
 * `WARNING_SOFTEN_CAP` (2) consecutive `warning` softenings, the plateau fires anyway — an AI
 * that keeps touching files round after round without ever passing is still stuck, and the
 * unbounded softening previously let it churn to the turn budget. Two is the smallest cap that
 * still gives one "yes, real code changed, keep going" grace round before calling it.
 *
 * The score-improvement exemption (rubric-pre-redesign) is gone — the PASS / FAIL rubric has no
 * numeric score to compare.
 *
 * Pure. No I/O.
 */

/**
 * One per-turn record consumed by {@link computePlateauVerdict}. The evaluator leaf appends
 * a record at the end of every turn so the next evaluator turn can detect plateaus across
 * the configured threshold of consecutive turns.
 *
 * `commitSubject` is the generator's *proposed* commit-message subject from the same turn — a
 * weak text proxy for "what would have been committed if we stopped here." Superseded by
 * `changedFilesHash`; retained only as a fallback for records written before the fingerprint
 * landed.
 *
 * `changedFilesHash` is a content fingerprint of the working tree's uncommitted changes the
 * evaluator leaf computes via the git runner (a hash over `git status --porcelain` + `git diff
 * HEAD`, NOT `git diff --stat`, which misses staged/untracked and collides on equal line
 * counts). Identical fingerprints across the window mean the AI changed nothing material — the
 * work-product exemption only fires when the fingerprint actually moved. Optional so the business
 * layer stays pure (the leaf supplies it); absent on records written before this field landed.
 *
 * `verdict` is the {@link PlateauVerdict} kind the predicate assigned this turn when it was
 * appended — stamped by the evaluator leaf so the warning cap is derivable purely from history
 * without threading a counter through ctx.
 */
export interface PlateauTurnRecord {
  readonly evaluation: EvaluationSignal;
  readonly critique?: string;
  readonly commitSubject?: string;
  readonly changedFilesHash?: string;
  readonly verdict?: PlateauVerdict['kind'];
}

/**
 * Outcome of the plateau predicate.
 *
 *   - `none`     — no plateau (not enough history, the failure count dropped, or the
 *                  critique-shift exemption applies). The loop continues normally.
 *   - `progress` — net-stall detected, but the critique prose shifted materially versus every
 *                  prior turn in the window. The loop continues; the evaluator's next turn decides.
 *   - `warning`  — net-stall detected AND the work-product fingerprint changed (the AI touched
 *                  files), so concrete change happened even though the verdict stayed unhappy.
 *                  The harness records a `plateau` warning on the attempt but does NOT exit the
 *                  loop yet — capped at {@link WARNING_SOFTEN_CAP} consecutive softenings.
 *   - `plateau`  — net-stall detected and no exemption applied (or the warning cap was hit).
 *                  The loop exits; finalize-gen-eval climbs the escalation ladder.
 */
export type PlateauVerdict =
  | { readonly kind: 'none' }
  | { readonly kind: 'progress'; readonly reason: 'critique-shifted' }
  | { readonly kind: 'warning'; readonly dimensions: readonly string[]; readonly reason: 'work-product-changed' }
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
 * Max consecutive `warning` softenings before the plateau fires regardless. An AI that keeps
 * touching files round after round without ever passing is still stuck; without a cap the
 * work-product exemption would let it churn to the turn budget. Two gives one grace round of
 * "real code changed, keep going" before the loop calls it — the smallest cap that preserves a
 * single benefit-of-the-doubt round.
 */
const WARNING_SOFTEN_CAP = 2;

/**
 * True when the failed-dimension COUNT never decreased across the ordered turns (each turn's
 * failure count ≥ the previous turn's). A drop anywhere in the window is real progress and
 * breaks the stall. See the module docstring for why count (not identical-set) is the predicate.
 */
const countNeverDecreased = (turns: readonly PlateauTurnRecord[]): boolean => {
  let prev = -1;
  for (const t of turns) {
    const n = failedDimensions(t.evaluation).size;
    if (prev !== -1 && n < prev) return false;
    prev = n;
  }
  return true;
};

/**
 * Count trailing consecutive `warning` verdicts in the prior-turn history. Drives the warning
 * cap — derivable purely from the stamped per-turn verdict, no ctx counter required.
 */
const trailingWarningStreak = (priorTurns: readonly PlateauTurnRecord[]): number => {
  let streak = 0;
  for (let i = priorTurns.length - 1; i >= 0; i--) {
    if (priorTurns[i]?.verdict === 'warning') streak += 1;
    else break;
  }
  return streak;
};

/**
 * True when `current`'s critique shifted materially versus EVERY prior turn in the window —
 * i.e. its maximum trigram-Jaccard similarity to any prior critique is still below the shift
 * threshold. Comparing against all priors (not just the most recent) defeats A/B/A critique
 * alternation, and also works at `plateauThreshold` 2 where the window holds a single prior.
 * Returns `false` when the current critique is empty (nothing to compare).
 */
const critiqueShiftedFromAll = (window: readonly PlateauTurnRecord[], current: PlateauTurnRecord): boolean => {
  const currentCritique = current.critique;
  if (currentCritique === undefined || currentCritique.trim().length === 0) return false;
  let maxSimilarity = 0;
  let comparedAny = false;
  for (const prior of window) {
    const priorCritique = prior.critique;
    if (priorCritique === undefined || priorCritique.trim().length === 0) continue;
    comparedAny = true;
    const sim = trigramJaccard(priorCritique, currentCritique);
    if (sim > maxSimilarity) maxSimilarity = sim;
  }
  // No prior critique to compare against → not a shift (fall through to the next check).
  return comparedAny && maxSimilarity < CRITIQUE_SHIFT_SIMILARITY;
};

const hasHash = (r: PlateauTurnRecord): boolean => r.changedFilesHash !== undefined && r.changedFilesHash.length > 0;

/**
 * True when `current`'s work-product fingerprint differs from EVERY prior turn in the window —
 * the AI changed the working tree, not just the commit message.
 *
 * EITHER-SIDE RULE (deliberate, conservative): the commit-subject text proxy runs ONLY when NO
 * record on either side of the comparison carries a fingerprint. When the current turn's hash is
 * missing but prior turns have hashes (the one live cause is a transient git failure in
 * `computeWorkProductFingerprint` — `plateauHistory` is in-memory per attempt, so mixed-version
 * records cannot occur), there is no evidence of change: return false rather than letting a
 * routinely-reworded commit subject grant an unwarranted softening. The consequence — a genuine
 * code change made during a git-hiccup round may plateau-exit — is acceptable because the exit
 * escalates rather than losing work. The mirrored case (current hash present, no prior hashes)
 * is equally conservative: `comparedAny === false` denies the exemption.
 */
const workProductChanged = (window: readonly PlateauTurnRecord[], current: PlateauTurnRecord): boolean => {
  const anyPriorHash = window.some(hasHash);
  if (hasHash(current)) {
    let comparedAny = false;
    for (const prior of window) {
      if (!hasHash(prior)) continue;
      comparedAny = true;
      if (prior.changedFilesHash === current.changedFilesHash) return false; // identical → no change
    }
    return comparedAny; // differs from every prior fingerprint we could compare
  }
  if (anyPriorHash) {
    // Current hash missing but priors carry hashes: no evidence of change — no exemption.
    return false;
  }

  // No fingerprint on EITHER side — fall back to the legacy commit-subject proxy against the
  // most recent prior turn (the only signal such records carry).
  const lastPrior = window[window.length - 1];
  const priorSubject = lastPrior?.commitSubject;
  const currentSubject = current.commitSubject;
  return (
    priorSubject !== undefined &&
    priorSubject.trim().length > 0 &&
    currentSubject !== undefined &&
    currentSubject.trim().length > 0 &&
    priorSubject.trim() !== currentSubject.trim()
  );
};

/**
 * Compute whether the just-completed evaluator turn (`current`) plateaus relative to the
 * previous `priorTurns`. See the module docstring for the net-progress predicate and the
 * exemption rules, and {@link PlateauVerdict} for the exit-decision taxonomy.
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

  // Window = last `threshold - 1` prior turns. The current turn must still have failures, and
  // the failure count must never have decreased across [window…current] — a drop is progress.
  const window = priorTurns.slice(-(threshold - 1));
  const currentFailed = failedDimensions(current.evaluation);
  if (currentFailed.size === 0) return { kind: 'none' };
  if (!countNeverDecreased([...window, current])) return { kind: 'none' };

  const dimensions = [...currentFailed];

  // Exemption 1 — the critique prose moved versus every prior turn in the window.
  if (critiqueShiftedFromAll(window, current)) {
    return { kind: 'progress', reason: 'critique-shifted' };
  }

  // Exemption 2 — the work-product fingerprint changed (real code edits). Capped: after
  // WARNING_SOFTEN_CAP consecutive softenings the loop is still stuck, so fire the plateau.
  if (workProductChanged(window, current) && trailingWarningStreak(priorTurns) < WARNING_SOFTEN_CAP) {
    return { kind: 'warning', dimensions, reason: 'work-product-changed' };
  }

  return { kind: 'plateau', dimensions };
};
