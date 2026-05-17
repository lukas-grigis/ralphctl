import type { EvaluationSignal } from '@src/domain/signal.ts';

/**
 * Plateau detection for the gen-eval inner loop.
 *
 * A generator ↔ evaluator loop can converge on a local optimum where every iteration
 * produces the same critique. Feeding the generator yet another round is wasteful — it has
 * already failed this fix once and burned turns + tokens. Detect when the evaluator flags
 * the identical set of failed dimensions across two consecutive rounds and short-circuit
 * the remaining gen-eval iterations.
 *
 * Pure. No I/O.
 *
 * Comparison rule: `dimensionsEqual(a, b)` compares the *set of failed dimension names* —
 * not the prose around them. The evaluator rewording the same critique (different wording,
 * same failures) still counts as a plateau.
 */

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
