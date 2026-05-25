/**
 * Runtime budgets for the generator–evaluator loop body. Lives here (not in domain) because
 * the values carry no domain knowledge — they're pure runtime knobs.
 *
 * `bootstrap/config.ts` re-uses this shape via `satisfies IterationConfig` on its zod schema,
 * keeping the two in sync without two sources of truth.
 */
export interface IterationConfig {
  /** Generator–evaluator turns budgeted per attempt. */
  readonly maxTurns: number;
  /** Cap on attempts per task before transitioning to `blocked`. */
  readonly maxAttempts: number;
  /** Adapter-side retries on `RateLimitError` before surfacing the failure. */
  readonly rateLimitRetries: number;
  /**
   * Consecutive evaluator turns flagging the same failed dimensions before the gen-eval loop
   * exits with a `plateau` warning (2–5). The plateau predicate exempts commit-message
   * progress and meaningfully-shifted critiques — see `business/task/plateau-detection.ts`.
   */
  readonly plateauThreshold: number;
  /**
   * When the gen-eval loop exits on a plateau, escalate the generator's model one rung up
   * the ladder defined by {@link escalationMap} (merged with the built-in
   * `DEFAULT_ESCALATION_MAP` in `business/task/escalation-map.ts`) and reissue the attempt
   * instead of transitioning the task straight to `blocked`. Mirrors the boolean on
   * `settings.harness.escalateOnPlateau`.
   */
  readonly escalateOnPlateau: boolean;
  /**
   * User overrides for `DEFAULT_ESCALATION_MAP`. Merged in
   * `business/task/escalation-map.ts#mergeEscalationMap` (user keys win, user-only keys extend
   * the ladder).
   */
  readonly escalationMap: Readonly<Record<string, string>>;
}
