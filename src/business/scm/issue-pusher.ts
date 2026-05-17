import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IssueOriginRef } from '@src/domain/entity/project.ts';

/**
 * Outbound port to write back to the source issue tracker. The two operations mirror what the
 * refine flow needs:
 *   - `update`: replace the body of an existing issue addressed by URL.
 *   - `create`: open a new issue on a configured origin (used when the ticket has no `link`
 *     and the project carries a `defaultIssueOrigin`). The adapter returns the URL of the
 *     created issue so the caller can attach it to `ticket.link`.
 *
 * Result semantics match {@link IssueFetcher}:
 *   - `Result.ok` on success (`void` for update, `{ url }` for create).
 *   - `Result.error(StorageError)` on system-level failure (CLI not installed, auth missing,
 *     network error, 4xx/5xx). The refine flow swallows these per the "graceful degrade" rule
 *     — local refinement is never blocked by a push failure.
 */
export interface IssuePusher {
  /**
   * Replace the body of the issue at `url`. The caller is responsible for the full new body
   * (including any footer / divider markers).
   */
  update(url: string, args: { readonly body: string }): Promise<Result<void, StorageError>>;
  /**
   * Open a new issue on the given origin. Returns the URL of the created issue.
   */
  create(
    origin: IssueOriginRef,
    args: { readonly title: string; readonly body: string }
  ): Promise<Result<{ readonly url: string }, StorageError>>;
}
