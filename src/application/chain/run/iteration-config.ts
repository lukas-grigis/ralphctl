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
}
