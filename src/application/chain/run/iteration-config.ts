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
   * Bounded corrective in-round nudges on a correctable `signals.json` contract failure before the
   * task self-blocks (1–5). Applies to generator and evaluator alike. Mirrors
   * `settings.harness.correctiveRetries`; consumes no turn/attempt budget (nudges happen inside one
   * turn). See `integration/ai/contract/_engine/corrective-retry.ts`.
   */
  readonly correctiveRetries: number;
  /**
   * Master switch for failure-driven generator-model escalation. Despite the name (kept for
   * backward compatibility) it gates ALL failure-driven escalation, not only plateau: on a
   * `plateau` or `budget-exhausted` exit the generator's model climbs one rung up the ladder
   * defined by {@link escalationMap} (merged with the built-in `DEFAULT_ESCALATION_MAP` in
   * `business/task/escalation-map.ts`) and the attempt is reissued; a `malformed` exit reissues on
   * the same model (the evaluator's failure never burns a ladder rung) — instead of settling the
   * task immediately. Mirrors the boolean on `settings.harness.escalateOnPlateau`.
   */
  readonly escalateOnPlateau: boolean;
  /**
   * User overrides for `DEFAULT_ESCALATION_MAP`. Merged in
   * `business/task/escalation-map.ts#mergeEscalationMap` (user keys win, user-only keys extend
   * the ladder).
   */
  readonly escalationMap: Readonly<Record<string, string>>;
  /**
   * Opt-in: skip the first pre-task verify of a launch when this launch's setup script already
   * verified the same tree (clean tree + setup succeeded this run). Mirrors the boolean on
   * `settings.harness.skipPreVerifyOnFreshSetup`; defaults `false`. See the field's JSDoc in
   * `domain/entity/settings.ts` for the soundness caveat (the setup script must actually verify,
   * not merely install).
   */
  readonly skipPreVerifyOnFreshSetup: boolean;
}
