/**
 * Domain validation error raised by value-object smart constructors when an
 * input fails the type's invariants.
 *
 * Structurally compatible with `KernelError` (`{ code, message, cause? }`) so
 * chain `Leaf`s can propagate it without translation.
 *
 * Carries the offending field name + value so diagnostics in logs / TUI
 * surface the failing input without lossy stringification at the call site.
 *
 * NOTE: This is the only domain error introduced as part of the value-object
 * landing. The full `DomainError` hierarchy (NotFound, Conflict, …) lands in
 * a later task; until then `ValidationError` stands alone.
 */
export interface ValidationErrorOptions {
  readonly field: string;
  readonly value: unknown;
  readonly message: string;
  readonly hint?: string;
}

export class ValidationError extends Error {
  /** Discriminator. `as const` keeps it narrow at the type level. */
  readonly code = 'invalid-value' as const;
  /** Logical field — usually the value-object name (e.g. "sprint-id"). */
  readonly field: string;
  /** The raw input that failed validation. Kept untyped on purpose. */
  readonly value: unknown;
  /** Optional human-readable repair hint. */
  readonly hint?: string;

  constructor(opts: ValidationErrorOptions) {
    super(opts.message);
    this.name = 'ValidationError';
    this.field = opts.field;
    this.value = opts.value;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
