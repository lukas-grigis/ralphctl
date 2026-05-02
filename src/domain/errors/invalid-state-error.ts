/**
 * `InvalidStateError` — raised when an entity rejects a state transition
 * because its current state forbids the attempted action.
 *
 * Examples:
 *  - Calling `Sprint.activate()` on a sprint that is already `closed`
 *  - Calling `Task.markDone()` on a task that is still `todo`
 *  - Calling `Sprint.addTicket()` on a non-`draft` sprint
 *
 * Carries enough machine-readable context (entity name, current state, the
 * action attempted) for callers and logs to render a precise diagnosis
 * without re-deriving it from the message.
 *
 * Structurally compatible with the kernel's `KernelError` shape
 * (`{ code, message, cause? }`) so chain elements can propagate it without
 * translation.
 */
export interface InvalidStateErrorOptions {
  readonly entity: string;
  readonly currentState: string;
  readonly attemptedAction: string;
  readonly message?: string;
  /** Optional human-readable repair hint. */
  readonly hint?: string;
}

export class InvalidStateError extends Error {
  /** Discriminator. `as const` keeps it narrow at the type level. */
  readonly code = 'invalid-state' as const;
  /** Logical entity name (e.g. "sprint", "ticket", "task"). */
  readonly entity: string;
  /** The state value blocking the transition. */
  readonly currentState: string;
  /** Identifier for the attempted operation (e.g. "add-ticket", "mark-done"). */
  readonly attemptedAction: string;
  /** Optional human-readable repair hint. */
  readonly hint?: string;

  constructor(opts: InvalidStateErrorOptions) {
    super(opts.message ?? `cannot ${opts.attemptedAction} on ${opts.entity} in state '${opts.currentState}'`);
    this.name = 'InvalidStateError';
    this.entity = opts.entity;
    this.currentState = opts.currentState;
    this.attemptedAction = opts.attemptedAction;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
