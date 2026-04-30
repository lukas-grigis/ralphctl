/**
 * `ParseError` — raised at the external-input boundary when AI output (or
 * any other untrusted text blob) cannot be coerced into the expected
 * domain shape.
 *
 * Distinct from {@link StorageError} (a system-level read/write failure on
 * persisted state) and {@link ValidationError} (a domain value-object
 * smart constructor rejection). `ParseError` covers two failure modes the
 * harness must distinguish:
 *
 *  - `invalid-json`     — the input wasn't JSON at all (no fenced block,
 *                          truncated payload, malformed syntax).
 *  - `schema-mismatch`  — JSON parsed but failed schema validation
 *                          (missing required fields, wrong types).
 *
 * Structurally compatible with the kernel's `KernelError` shape
 * (`{ code, message, cause? }`) so chain elements can propagate it without
 * translation.
 */
export type ParseErrorSubCode = 'invalid-json' | 'schema-mismatch';

export interface ParseErrorOptions {
  readonly subCode: ParseErrorSubCode;
  readonly message: string;
  readonly cause?: unknown;
  /** Optional human-readable repair hint. */
  readonly hint?: string;
}

export class ParseError extends Error {
  /** Discriminator. `as const` keeps it narrow at the type level. */
  readonly code = 'parse-error' as const;
  /** Narrower failure family — see {@link ParseErrorSubCode}. */
  readonly subCode: ParseErrorSubCode;
  /** Wrapped lower-level error (e.g. the original `SyntaxError` from `JSON.parse`). */
  override readonly cause: unknown;
  /** Optional human-readable repair hint. */
  readonly hint?: string;

  constructor(opts: ParseErrorOptions) {
    super(opts.message);
    this.name = 'ParseError';
    this.subCode = opts.subCode;
    this.cause = opts.cause;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
