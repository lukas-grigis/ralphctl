/**
 * Plateau detection for the evaluator fix loop.
 *
 * Anthropic's harness-design guidance notes that a generator/evaluator
 * loop can converge on a local optimum where every iteration produces the
 * same critique. Feeding the generator yet another round is wasteful — it
 * has already failed this fix once and burned turns + tokens. Detect when
 * the evaluator keeps flagging the identical set of failed dimensions
 * across two consecutive rounds and short-circuit the remaining fix
 * attempts.
 *
 * Pure. No I/O. The chain layer threads this in around `EvaluateTaskUseCase`.
 *
 * Comparison rule: `dimensionsEqual(a, b)` compares the **set of failed
 * dimension names** — not the prose around them. The evaluator rewording
 * the same critique (different wording, same failures) should still be
 * detected as a plateau.
 */
import type { EvaluationSignal } from '../../../domain/signals/harness-signal.ts';

/**
 * Extract the set of failed dimension names from a parsed evaluation.
 * Normalises by lower-casing + trimming so `Correctness` / `correctness ` /
 * `correctness` are treated as the same dimension.
 */
export function failedDimensions(signal: EvaluationSignal): ReadonlySet<string> {
  const names = new Set<string>();
  for (const d of signal.dimensions) {
    if (!d.passed) {
      names.add(d.dimension.trim().toLowerCase());
    }
  }
  return names;
}

/**
 * Two evaluation signals plateau when the sets of failed dimensions are
 * identical AND non-empty.
 *
 * Returns `false` when either set is empty — a result with no failures
 * couldn't have driven us into the fix loop, and we shouldn't treat
 * "no failures detected" as a stable plateau worth short-circuiting on.
 */
export function dimensionsEqual(prev: EvaluationSignal, curr: EvaluationSignal): boolean {
  const a = failedDimensions(prev);
  const b = failedDimensions(curr);
  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return false;
  for (const name of a) {
    if (!b.has(name)) return false;
  }
  return true;
}
