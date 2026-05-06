/**
 * `CheckFailedError` — raised by the post-task check gate when a configured
 * `checkScript` exits non-zero. The error is the explicit signal that the
 * AI's work failed verification — distinct from spawn-level breakage
 * (missing binary, EPERM, …) which surfaces as a `StorageError` and is
 * absorbed by an outer `OnError` so a flaky environment doesn't strand a
 * task.
 *
 * The discriminator `code: 'check-failed'` lets the per-task chain's
 * `OnError.catchIf` discriminate hard-gate failures from any other kernel
 * error without scanning message strings.
 *
 * Sibling note: `InvalidStateError({ currentState: 'check-failed' })` at
 * `execute-flow.ts` is the SPRINT-START hard-abort path — distinct from
 * this per-task signal. Keeping them on different classes preserves the
 * "abort vs. block one task" semantics at the type level.
 *
 * Structurally compatible with the kernel's `KernelError` shape
 * (`{ code, message, cause? }`) so chain elements can propagate it without
 * translation.
 */
export interface CheckFailedErrorOptions {
  /** Captured stdout/stderr from the failing check script. */
  readonly output: string;
  /** Optional override for the default message. */
  readonly message?: string;
  /** Optional underlying cause (e.g. the script's exit metadata). */
  readonly cause?: unknown;
}

export class CheckFailedError extends Error {
  /** Discriminator. `as const` keeps it narrow at the type level. */
  readonly code = 'check-failed' as const;
  /** Captured output of the failing script — surfaced to logs / progress. */
  readonly output: string;

  constructor(opts: CheckFailedErrorOptions) {
    super(opts.message ?? 'post-task check script failed');
    this.name = 'CheckFailedError';
    this.output = opts.output;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}
