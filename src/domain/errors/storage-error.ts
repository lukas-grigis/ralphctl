/**
 * `StorageError` — raised by the persistence layer for system-level
 * failures while reading or writing aggregate state.
 *
 * Distinct from {@link NotFoundError} (a missing entity is a *normal*
 * outcome) and {@link ValidationError} (bad domain input). `StorageError`
 * means the storage backend itself misbehaved or returned data the
 * persistence layer cannot make sense of.
 *
 * The `subCode` discriminator narrows the cause family:
 *  - `io`              — low-level filesystem / OS error (read/write failed)
 *  - `lock`            — file-lock contention or stale lock
 *  - `parse`           — JSON parse failure on persisted blob
 *  - `schema-mismatch` — JSON parsed but failed Zod schema validation
 *  - `no-changes`      — semantically a no-op (e.g. autoCommit on a clean
 *                        tree) — distinct so callers can detect it without
 *                        relying on a brittle message-string match.
 *
 * Structurally compatible with the kernel's `KernelError` shape
 * (`{ code, message, cause? }`) so chain elements can propagate it without
 * translation.
 */
export type StorageErrorSubCode = 'io' | 'lock' | 'parse' | 'schema-mismatch' | 'no-changes';

export interface StorageErrorOptions {
  readonly subCode: StorageErrorSubCode;
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
  /** Optional human-readable repair hint. */
  readonly hint?: string;
}

export class StorageError extends Error {
  /** Discriminator. `as const` keeps it narrow at the type level. */
  readonly code = 'storage-error' as const;
  /** Narrower failure family — see {@link StorageErrorSubCode}. */
  readonly subCode: StorageErrorSubCode;
  /** Filesystem path involved in the failure, when known. */
  readonly path: string | undefined;
  /** Wrapped lower-level error (e.g. the original `NodeJS.ErrnoException`). */
  override readonly cause: unknown;
  /** Optional human-readable repair hint. */
  readonly hint?: string;

  constructor(opts: StorageErrorOptions) {
    super(opts.message);
    this.name = 'StorageError';
    this.subCode = opts.subCode;
    this.path = opts.path;
    this.cause = opts.cause;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
