import { isFatalChainError } from '@src/domain/value/error/is-fatal-chain-error.ts';
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
 * The fatal set — user cancellation and an exhausted-retry rate limit — is the shared
 * {@link isFatalChainError} predicate: those two codes tear down any chain, not just a task turn.
 *
 * Everything else — `InvalidStateError` signals-missing / spawn-exit-N (`invalid-state`),
 * `ParseError` invalid-json / schema-mismatch (`parse-error`), `MigrationGapError`
 * (`migration-gap`), and any other domain error — is treated as recoverable: block this task,
 * keep the run going.
 */
export const isRecoverableTurnError = (err: DomainError): boolean => !isFatalChainError(err);
