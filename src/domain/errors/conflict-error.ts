/**
 * `ConflictError` — raised when an aggregate rejects an operation because
 * an identifier already exists in the aggregate.
 *
 * Examples:
 *  - Adding a `Ticket` whose id is already present on a `Sprint`
 *  - Adding a `Repository` whose path is already registered on a `Project`
 *
 * Structurally compatible with the kernel's `KernelError` shape
 * (`{ code, message, cause? }`) so chain elements can propagate it without
 * translation.
 */
export interface ConflictErrorOptions {
  readonly entity: string;
  readonly conflictingId: string;
  readonly message?: string;
  /** Optional human-readable repair hint. */
  readonly hint?: string;
}

export class ConflictError extends Error {
  /** Discriminator. `as const` keeps it narrow at the type level. */
  readonly code = 'conflict' as const;
  /** Logical entity name (e.g. "ticket", "repository"). */
  readonly entity: string;
  /** The duplicate identifier or path that caused the conflict. */
  readonly conflictingId: string;
  /** Optional human-readable repair hint. */
  readonly hint?: string;

  constructor(opts: ConflictErrorOptions) {
    super(opts.message ?? `${opts.entity} with id '${opts.conflictingId}' already exists`);
    this.name = 'ConflictError';
    this.entity = opts.entity;
    this.conflictingId = opts.conflictingId;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
