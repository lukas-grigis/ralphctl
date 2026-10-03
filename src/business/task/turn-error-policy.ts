import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { isFatalChainError } from '@src/domain/value/error/is-fatal-chain-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { GenEvalExit } from '@src/business/task/gen-eval-exit.ts';
import { abortCauseFromError } from '@src/business/task/abort-cause-from-error.ts';

/**
 * Decide whether an AI-turn error (from `callImplement` / `callEvaluate`) is a *recoverable*
 * contract failure that should block the in-flight task, or a *fatal* error that must propagate
 * and abort the whole chain.
 *
 * Why this split exists: the gen-eval `loop` primitive propagates any body `Result.error`,
 * which aborts the entire per-task subchain — and with it every remaining todo task. Non-Claude
 * providers (codex / copilot) trip the strict `signals.json` contract far more often than Claude
 * (wrong shape, wrong place, or not written at all), so a single bad turn used to take down the
 * whole implement run. Converting these to a per-task block surfaces the failure (HARNESS-
 * PRINCIPLES §5 "blocked surfaces them") while letting the other tasks run.
 *
 * The fatal set — user cancellation and an exhausted-retry rate limit — is the shared
 * {@link isFatalChainError} predicate: those two codes tear down any chain, not just a task turn.
 *
 * Everything else — `InvalidStateError` signals-missing / spawn-exit-N (`invalid-state`),
 * `ParseError` invalid-json / schema-mismatch (`parse-error`), `MigrationGapError`
 * (`migration-gap`), and any other domain error — is treated as recoverable: block this task,
 * keep the run going.
 */
export const isRecoverableTurnError = (err: DomainError): boolean => !isFatalChainError(err);

/** The two loop exits a recoverable turn error maps to. */
type TurnFailureExit = Extract<GenEvalExit, { readonly kind: 'crashed' | 'self-blocked' }>;

/**
 * Map a failed `callImplement` / `callEvaluate` to the turn's outcome, identically for both roles
 * (both spawn through the same headless provider and watchdog, so they die the same ways):
 *
 *  - fatal (user abort, rate-limit-after-retries) → `Result.error`, aborting the whole run.
 *  - `ProcessCrash` (watchdog kill / spawn crash / non-zero exit with no signals.json) → a
 *    `crashed` exit — a transient process death that finalize retries within `maxAttempts`.
 *  - anything else is a signals-contract failure → a `self-blocked` exit that blocks THIS task
 *    without taking down the remaining ones (and never marks ungraded work done).
 *
 * The error message rides the exit reason so the operator / progress.md shows WHY the turn failed.
 */
export const classifyTurnFailure = (
  err: DomainError,
  role: 'generator' | 'evaluator',
  log: Logger,
  taskId: string
): Result<TurnFailureExit, DomainError> => {
  if (!isRecoverableTurnError(err)) {
    log.error(`${role === 'generator' ? 'implement' : 'evaluate'} call failed (fatal — propagating)`, {
      taskId,
      error: err.message,
    });
    return Result.error(err);
  }
  if (err.code === ErrorCode.ProcessCrash) {
    log.warn(
      `${role === 'generator' ? 'AI' : 'evaluator'} process was killed before producing signals.json — retrying attempt`,
      { taskId, error: err.message }
    );
    return Result.ok({
      kind: 'crashed',
      reason: `AI process was killed before producing signals.json: ${err.message}`,
      ...abortCauseFromError(err),
    });
  }
  log.warn(`${role} did not produce a valid signals.json — blocking task`, { taskId, error: err.message });
  return Result.ok({ kind: 'self-blocked', reason: `${role} did not produce a valid signals.json: ${err.message}` });
};
