import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export interface ProcessCrashErrorOptions {
  readonly entity: string;
  /** Short state discriminator for logs — e.g. `exit-143`, `spawn-failed`. */
  readonly state: string;
  readonly message: string;
  readonly hint?: string;
}

/**
 * A transient death of an AI child process that is worth RETRYING: the idle-stdout watchdog
 * SIGTERM'd a wedged child, the spawn itself failed before stdin drained, or the process exited
 * non-zero without ever writing its `signals.json`. Distinct from {@link InvalidStateError}
 * precisely so the retry decision can be made on the error TYPE: a `ProcessCrash` re-runs the
 * generator within `maxAttempts` (then blocks at the cap), whereas a config failure
 * (model-unavailable) keeps surfacing as an `InvalidStateError` and blocks after one attempt —
 * retrying it would just burn the whole budget on the same misconfiguration.
 *
 * Carries the exit-code / signal / stderr-tail context in `message` (not just `.hint`) so the
 * text survives unchanged through `run-generator-turn`'s crash-reason string into the progress
 * journal and the TUI without touching the render layer.
 */
export class ProcessCrashError extends Error {
  readonly code = ErrorCode.ProcessCrash;
  readonly entity: string;
  readonly state: string;
  readonly hint?: string;

  constructor(opts: ProcessCrashErrorOptions) {
    super(opts.message);
    this.name = 'ProcessCrashError';
    this.entity = opts.entity;
    this.state = opts.state;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
