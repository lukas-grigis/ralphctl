import type { PlateauSource } from '@src/domain/entity/attempt.ts';

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
 *   - `crashed`           — AI process died (watchdog kill / spawn crash) before producing a
 *                          terminal verdict; the attempt is retried within maxAttempts, then
 *                          blocked at the cap.
 *   - `malformed`         — evaluator emitted no terminal verdict; attempt fails with warning.
 *   - `plateau`           — one of three detectors fired (see {@link PlateauSource}): the
 *                          count-based threshold, the loop-diversity guard, or the action-entropy
 *                          guard. `source` names which one — optional, pure instrumentation.
 *   - `budget-exhausted`  — `maxTurns` reached without a terminal verdict.
 */
export type GenEvalExit =
  | { readonly kind: 'passed' }
  | { readonly kind: 'self-blocked'; readonly reason: string }
  | { readonly kind: 'crashed'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[]; readonly source?: PlateauSource }
  | { readonly kind: 'budget-exhausted'; readonly turnsUsed: number; readonly turnBudget: number };
