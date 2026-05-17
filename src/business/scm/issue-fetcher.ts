import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * External issue tracker port. Used by chains that benefit from issue context (refine
 * pre-fetches the issue body when a ticket has a `link` to a GitHub/GitLab issue).
 *
 * Result semantics:
 *  - `Result.ok(issue)` — fetched cleanly.
 *  - `Result.ok(null)`  — URL is well-formed but the issue couldn't be resolved (unrecognised
 *    host, 404, private). Caller treats null the same as "no link" — proceeds without context.
 *  - `Result.error(StorageError)` — system-level failure: CLI tool not installed, malformed
 *    response. Caller decides whether to soft-fail (refine) or surface (other consumers).
 */
export interface ExternalIssue {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  /** Most recent N comments, oldest-first. Empty when none. */
  readonly comments: readonly ExternalIssueComment[];
}

export interface ExternalIssueComment {
  readonly author: string;
  readonly body: string;
}

export type IssueFetcher = (url: string) => Promise<Result<ExternalIssue | null, StorageError>>;

/**
 * Format an `ExternalIssue` as markdown ready to embed in a prompt under
 * `<context>...</context>`. Pure — lives next to the port so consumers in `core/` and
 * `orchestration/` can use it without reaching into adapters.
 */
export const formatIssueContext = (issue: ExternalIssue): string => {
  const lines: string[] = [];
  lines.push('## Source Issue Data');
  lines.push('');
  lines.push(`**Title:** ${issue.title}`);
  lines.push(`**State:** ${issue.state}`);
  if (issue.url) lines.push(`**URL:** ${issue.url}`);
  lines.push('');
  if (issue.body.trim().length > 0) {
    lines.push('**Body:**');
    lines.push('');
    lines.push(issue.body);
    lines.push('');
  }
  if (issue.comments.length > 0) {
    lines.push(`**Comments (${String(issue.comments.length)}):**`);
    lines.push('');
    for (const c of issue.comments) {
      lines.push('---');
      lines.push(`**@${c.author}**:`);
      lines.push('');
      lines.push(c.body);
      lines.push('');
    }
  }
  return lines.join('\n');
};
