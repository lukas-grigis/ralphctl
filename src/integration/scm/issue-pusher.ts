import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import { runCli } from '@src/integration/io/run-cli.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { parseIssueUrl } from '@src/integration/scm/issue-fetcher.ts';

/**
 * CLI-backed `IssuePusher`. Same shape as {@link createIssueFetcher}: dispatches to `gh` or
 * `glab` based on the URL host. Auth is whatever the user already has configured for those
 * tools — we don't store tokens.
 *
 * The body is posted as a comment — the issue's own description is never modified. GitHub
 * reads the comment body from stdin (`gh issue comment --body-file -`) so embedded newlines /
 * markdown / quotes round-trip cleanly; glab takes it as a `--body` flag value (each argv
 * element is marshalled as a separate exec arg, so no shell parsing mangles it).
 *
 * Errors:
 *  - CLI not installed → `StorageError(subCode: 'io', message: '<cli> not installed …')`
 *  - 4xx/5xx → `StorageError(subCode: 'io', message: '<cli> issue …: <stderr>')`
 *  - Timeout → `StorageError(subCode: 'io', message: '<cli> timed out …')`
 */

const CLI_TIMEOUT_MS = 30_000;

const commentGitHub = async (
  spawn: Spawn,
  url: string,
  body: string,
  parsed: { owner: string; repo: string; number: number }
): Promise<Result<void, StorageError>> => {
  // `gh issue comment <number> --repo <owner>/<repo> --body-file -` reads body from stdin.
  const r = await runCli(
    spawn,
    'gh',
    ['issue', 'comment', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--body-file', '-'],
    { stdin: body, timeoutMs: CLI_TIMEOUT_MS }
  );
  if (!r.ok) return Result.error(r.error);
  if (r.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `gh issue comment failed: ${r.value.stderr.trim() || 'unknown error'} (url=${url})`,
      })
    );
  }
  return Result.ok(undefined);
};

const commentGitLab = async (
  spawn: Spawn,
  url: string,
  body: string,
  parsed: { owner: string; repo: string; number: number }
): Promise<Result<void, StorageError>> => {
  // `glab issue comment <number> --repo <owner>/<repo> --body <body>` — glab doesn't accept
  // the body via stdin, so we pass it as a flag value. Markdown / newlines survive because
  // spawn marshals each argv element as a separate exec arg (no shell parsing).
  const r = await runCli(
    spawn,
    'glab',
    ['issue', 'comment', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--body', body],
    { timeoutMs: CLI_TIMEOUT_MS }
  );
  if (!r.ok) return Result.error(r.error);
  if (r.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `glab issue comment failed: ${r.value.stderr.trim() || 'unknown error'} (url=${url})`,
      })
    );
  }
  return Result.ok(undefined);
};

export interface IssuePusherDeps {
  readonly spawn: Spawn;
}

export const createIssuePusher = (deps: IssuePusherDeps): IssuePusher => ({
  async comment(url, { body }) {
    const parsed = parseIssueUrl(url);
    if (parsed === null) {
      return Result.error(
        new StorageError({
          subCode: 'parse',
          message: `unsupported issue URL: ${url}`,
        })
      );
    }
    if (parsed.host === 'github') return commentGitHub(deps.spawn, url, body, parsed);
    return commentGitLab(deps.spawn, url, body, parsed);
  },
});
