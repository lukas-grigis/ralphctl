import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Origin discovered from a repository's `origin` remote. `null` from {@link IssuePusher.resolveOrigin}
 * means the remote is missing or is not GitHub/GitLab — not a transport failure.
 */
export interface IssueTrackerOrigin {
  readonly provider: 'github' | 'gitlab';
  readonly hostname: string;
  readonly owner: string;
  readonly repo: string;
}

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
   * Read the first `origin` remote at `cwd` and parse it as GitHub or GitLab. Returns
   * `ok(null)` when origin is missing or not a GitHub/GitLab host. Transport failures
   * (git not installed, spawn error) are `StorageError`.
   */
  resolveOrigin(cwd: AbsolutePath): Promise<Result<IssueTrackerOrigin | null, StorageError>>;

  /**
   * Create an issue on the tracker implied by `cwd`'s origin. Body may be empty. The
   * returned `url` is the new issue's web URL.
   */
  create(args: {
    readonly cwd: AbsolutePath;
    readonly title: string;
    readonly body: string;
  }): Promise<Result<{ url: string }, StorageError>>;

  /**
   * Every comment body on the issue at `url`, oldest-first, untruncated. The issue's own
   * description is not included.
   */
  listComments(url: string): Promise<Result<readonly string[], StorageError>>;

  /**
   * Post a new comment on the issue at `url`. The caller is responsible for the full comment
   * body (including any footer / signature markers). The issue's own description is never
   * touched.
   */
  comment(url: string, args: { readonly body: string }): Promise<Result<void, StorageError>>;
}
