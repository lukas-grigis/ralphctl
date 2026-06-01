import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Outbound port to write back to the source issue tracker. Refine never mutates the issue
 * body — it leaves the original description authored by a human untouched and instead appends
 * the refined requirements as a comment on the linked issue.
 *
 * Result semantics match {@link IssueFetcher}:
 *   - `Result.ok(undefined)` on success.
 *   - `Result.error(StorageError)` on system-level failure (CLI not installed, auth missing,
 *     network error, 4xx/5xx). The refine flow swallows these per the "graceful degrade" rule
 *     — local refinement is never blocked by a push failure.
 */
export interface IssuePusher {
  /**
   * Post a new comment on the issue at `url`. The caller is responsible for the full comment
   * body (including any footer / signature markers). The issue's own description is never
   * touched.
   */
  comment(url: string, args: { readonly body: string }): Promise<Result<void, StorageError>>;
}
