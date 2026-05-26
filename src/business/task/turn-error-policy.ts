import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

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
 * Two error codes MUST still propagate (return `false`):
 *   - `Aborted`   — user cancellation (Ctrl-C / TUI abort). CLAUDE.md §"AbortError is the one
 *                   error chains propagate transparently." A guard converting it to a block
 *                   would swallow the cancel.
 *   - `RateLimit` — the adapter already exhausted its internal 429 retries; continuing to the
 *                   next task would just re-hit the limit, so let it abort the run.
 *
 * Everything else — `InvalidStateError` signals-missing / spawn-exit-N (`invalid-state`),
 * `ParseError` invalid-json / schema-mismatch (`parse-error`), `MigrationGapError`
 * (`migration-gap`), and any other domain error — is treated as recoverable: block this task,
 * keep the run going.
 */
export const isRecoverableTurnError = (err: DomainError): boolean =>
  err.code !== ErrorCode.Aborted && err.code !== ErrorCode.RateLimit;
