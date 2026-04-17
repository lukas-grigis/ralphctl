/**
 * Plateau detection for the evaluator fix loop.
 *
 * Anthropic's harness-design guidance notes that a generator/evaluator
 * loop can converge on a local optimum where every iteration produces the
 * same critique. Feeding the generator yet another round is wasteful — it
 * has already failed this fix once and burned turns + tokens. Detect when
 * the evaluator keeps flagging the identical set of failed dimensions
 * across two consecutive rounds and short-circuit the remaining fix
 * attempts with status `'plateau'`.
 *
 * `dimensionsEqual(a, b)` compares the **set of FAIL dimension names** —
 * not the prose around them. The evaluator rewording the same critique
 * (different wording, same failures) should still be detected as a plateau.
 *
 * Pure. No I/O. The evaluator use case threads this in.
 */

import type { EvaluationParseResult } from '@src/business/ports/output-parser.ts';

/**
 * Extract the set of failed dimension names from a parsed evaluation.
 *
 * Normalises by:
 *   - lower-casing (`Correctness` and `correctness` are the same dimension)
 *   - trimming whitespace (`"Correctness "` and `"Correctness"` are the same)
 *
 * Dimensions with status `'PASS'` are excluded — plateau is about stuck
 * failures, not repeat passes.
 */
export function failedDimensions(result: EvaluationParseResult): ReadonlySet<string> {
  const names = new Set<string>();
  for (const d of result.dimensions) {
    if (d.status === 'FAIL') {
      names.add(d.dimension.trim().toLowerCase());
    }
  }
  return names;
}

/**
 * Two results plateau when the sets of failed dimensions are identical.
 *
 * Returns false when either set is empty — a result with no failures
 * couldn't have led us here, and we shouldn't treat "no failures detected"
 * as a stable plateau worth short-circuiting on.
 */
export function dimensionsEqual(prev: EvaluationParseResult, curr: EvaluationParseResult): boolean {
  const a = failedDimensions(prev);
  const b = failedDimensions(curr);
  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return false;
  for (const name of a) {
    if (!b.has(name)) return false;
  }
  return true;
}
