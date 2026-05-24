/**
 * Outcome types for one run of the gen-eval inner loop. Owned by the business layer because the
 * decision tree from exit → (settle verdict, attempt warning) is domain logic — settle-attempt
 * and finalize-gen-eval both read these types.
 */

/** Settled per-attempt verdict, derived from `GenEvalExit` by `finalize-gen-eval`. */
export type RunTaskVerdict = 'passed' | 'failed' | 'malformed';

/**
 * Why the gen-eval loop terminated.
 *
 *   - `passed`            — evaluator's `signals.json` carried an `evaluation` signal with
 *                          `status: 'passed'`; attempt succeeds.
 *   - `self-blocked`      — generator's `signals.json` carried a `task-blocked` signal; task
 *                          settles as blocked.
 *   - `malformed`         — evaluator emitted no terminal verdict; attempt fails with warning.
 *   - `plateau`           — two consecutive evaluator runs flagged the same failed dimensions.
 *   - `budget-exhausted`  — `maxTurns` reached without a terminal verdict.
 */
export type GenEvalExit =
  | { readonly kind: 'passed' }
  | { readonly kind: 'self-blocked'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[] }
  | { readonly kind: 'budget-exhausted'; readonly turnsUsed: number; readonly turnBudget: number };
