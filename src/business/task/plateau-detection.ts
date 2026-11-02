import type { EvaluationSignal } from '@src/domain/signal.ts';

/**
 * Plateau detection for the gen-eval inner loop. A window stalls when the failed-dimension COUNT
 * never decreased across it and the current turn still fails — counting (not comparing sets)
 * catches an oscillating set ({A,B}→{B,C}→{A,C}) that an identical-set check never flags.
 *
 * A stall is exempted, in order, by:
 *  1. critique shift — the evaluator's prose moved materially versus every prior turn → `progress`;
 *  2. work-product change — the working-tree fingerprint moved → `warning`, capped at
 *     {@link WARNING_SOFTEN_CAP} consecutive softenings before the plateau fires anyway.
 */

/** One evaluator turn, appended by the evaluator leaf. */
export interface PlateauTurnRecord {
  readonly evaluation: EvaluationSignal;
  readonly critique?: string;
  /** Proposed commit subject — fallback proxy only when no record carries `changedFilesHash`. */
  readonly commitSubject?: string;
  /**
   * Hash over `git status --porcelain` + `git diff HEAD` (not `--stat`, which misses untracked files
   * and collides on equal line counts), computed by the leaf so this module stays pure.
   */
  readonly changedFilesHash?: string;
  /** The verdict assigned when appended, so the warning cap derives from history alone. */
  readonly verdict?: PlateauVerdict['kind'];
}

/**
 * `none` — no stall (short history, count dropped, or zero failures); `progress` — stall exempted
 * by a critique shift; `warning` — stall softened by a work-product change (recorded, loop
 * continues); `plateau` — the loop exits and finalize-gen-eval climbs the escalation ladder.
 */
export type PlateauVerdict =
  | { readonly kind: 'none' }
  | { readonly kind: 'progress'; readonly reason: 'critique-shifted' }
  | { readonly kind: 'warning'; readonly dimensions: readonly string[]; readonly reason: 'work-product-changed' }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[] };

export interface PlateauOptions {
  /** Window size in turns; clamped by {@link plateauWindowSize}. */
  readonly threshold: number;
}

/** Failed dimension names, trimmed and lowercased. `applicable: false` is neither pass nor fail. */
export const failedDimensions = (signal: EvaluationSignal): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const d of signal.dimensions) {
    if (d.applicable !== false && !d.passed) {
      names.add(d.dimension.trim().toLowerCase());
    }
  }
  return names;
};

/** Whitespace-collapsed character trigrams; a string under 3 chars is its own single gram. */
const trigrams = (text: string): ReadonlySet<string> => {
  const normalised = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalised.length < 3) return new Set([normalised]);
  const grams = new Set<string>();
  for (let i = 0; i <= normalised.length - 3; i += 1) {
    grams.add(normalised.slice(i, i + 3));
  }
  return grams;
};

/** Jaccard similarity over character trigrams, in `[0, 1]`. */
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
 * Consecutive softenings before the plateau fires anyway: an AI that keeps touching files without
 * passing is still stuck. Two is the smallest cap that keeps one grace round.
 */
const WARNING_SOFTEN_CAP = 2;

/** True when no turn's failure count is lower than the previous turn's — a drop is real progress. */
const countNeverDecreased = (turns: readonly PlateauTurnRecord[]): boolean => {
  let prev = -1;
  for (const t of turns) {
    const n = failedDimensions(t.evaluation).size;
    if (prev !== -1 && n < prev) return false;
    prev = n;
  }
  return true;
};

const trailingWarningStreak = (prior: readonly PlateauTurnRecord[]): number =>
  prior.length - 1 - prior.findLastIndex((t) => t.verdict !== 'warning');

const nonBlank = (text: string | undefined): text is string => text !== undefined && text.trim().length > 0;

/**
 * The current critique is below the similarity threshold against EVERY prior critique — comparing
 * against all priors defeats A/B/A alternation. No prior critique → no shift.
 */
const critiqueShiftedFromAll = (window: readonly PlateauTurnRecord[], current: PlateauTurnRecord): boolean => {
  const currentCritique = current.critique;
  if (!nonBlank(currentCritique)) return false;
  const sims = window
    .map((prior) => prior.critique)
    .filter(nonBlank)
    .map((critique) => trigramJaccard(critique, currentCritique));
  return sims.length > 0 && Math.max(...sims) < CRITIQUE_SHIFT_SIMILARITY;
};

const hasHash = (r: PlateauTurnRecord): boolean => r.changedFilesHash !== undefined && r.changedFilesHash.length > 0;

/**
 * The working-tree fingerprint differs from EVERY hashed prior — matching any prior means the AI
 * cycled back (A→B→A), which is churn. The commit-subject proxy runs only when NO record on either
 * side carries a hash: a missing current hash (a transient git failure) is no evidence of change,
 * and a routinely reworded subject must not grant a softening. A plateau exit escalates rather than
 * losing work, so erring this way is safe.
 */
const workProductChanged = (window: readonly PlateauTurnRecord[], current: PlateauTurnRecord): boolean => {
  const hashed = window.filter(hasHash);
  if (hasHash(current)) {
    return hashed.length > 0 && hashed.every((prior) => prior.changedFilesHash !== current.changedFilesHash);
  }
  if (hashed.length > 0) return false;
  const priorSubject = window.at(-1)?.commitSubject;
  const currentSubject = current.commitSubject;
  return nonBlank(priorSubject) && nonBlank(currentSubject) && priorSubject.trim() !== currentSubject.trim();
};

/**
 * `settings.harness.plateauThreshold` clamped to 2–5 — defensive, since a bad value must not crash
 * or silence the loop. The single window size for this predicate and `composeDimensionTrajectory`.
 */
export const plateauWindowSize = (threshold: number): number => {
  if (!Number.isFinite(threshold)) return 2;
  return Math.max(2, Math.min(5, Math.trunc(threshold)));
};

/** Does the just-completed evaluator turn plateau relative to `priorTurns`? */
export const computePlateauVerdict = (
  priorTurns: readonly PlateauTurnRecord[],
  current: PlateauTurnRecord,
  options: PlateauOptions
): PlateauVerdict => {
  const threshold = plateauWindowSize(options.threshold);
  if (priorTurns.length < threshold - 1) return { kind: 'none' };
  const window = priorTurns.slice(-(threshold - 1));
  const failed = failedDimensions(current.evaluation);
  if (failed.size === 0 || !countNeverDecreased([...window, current])) return { kind: 'none' };
  if (critiqueShiftedFromAll(window, current)) return { kind: 'progress', reason: 'critique-shifted' };
  const dimensions = [...failed];
  if (workProductChanged(window, current) && trailingWarningStreak(priorTurns) < WARNING_SOFTEN_CAP) {
    return { kind: 'warning', dimensions, reason: 'work-product-changed' };
  }
  return { kind: 'plateau', dimensions };
};
