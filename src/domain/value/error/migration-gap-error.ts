import { ErrorCode } from '@src/domain/value/error/error-code.ts';

export interface MigrationGapErrorOptions {
  /** Schema version on disk (or the highest the migration chain reached). */
  readonly from: number;
  /** Schema version the caller (per-leaf contract or repository) is asking to load at. */
  readonly to: number;
  /**
   * Free-form pointer at the offending artefact — typically an absolute file path or a
   * repository name. Surfaced in the error message and hint.
   */
  readonly file: string;
  readonly message?: string;
  readonly hint?: string;
}

/**
 * Schema version on disk is older than the caller expects AND no migration step is
 * registered for the gap. The version-walk loop (in `validate-signals-file.ts` or a per-
 * entity repository loader) raises this when `migrations[v]` is `undefined` for some
 * `v ∈ [from, to)`.
 *
 * In-flight artefacts can survive harness upgrades transparently when every step is
 * registered; this error fires only when an explicit step is missing. The harness does NOT
 * fabricate a default migration — that would risk silent data loss.
 */
export class MigrationGapError extends Error {
  readonly code = ErrorCode.MigrationGap;
  readonly from: number;
  readonly to: number;
  readonly file: string;
  readonly hint?: string;

  constructor(opts: MigrationGapErrorOptions) {
    super(opts.message ?? `no migration step from v${String(opts.from)} to v${String(opts.from + 1)} for ${opts.file}`);
    this.name = 'MigrationGapError';
    this.from = opts.from;
    this.to = opts.to;
    this.file = opts.file;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
  }
}
