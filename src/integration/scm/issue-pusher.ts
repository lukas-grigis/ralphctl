import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import type { IssueOriginRef } from '@src/domain/entity/project.ts';
import { runCli } from '@src/integration/io/run-cli.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { parseIssueUrl } from '@src/integration/scm/issue-fetcher.ts';

/**
 * CLI-backed `IssuePusher`. Same shape as {@link createIssueFetcher}: dispatches to `gh` or
 * `glab` based on the URL host (for updates) or the configured `provider` (for creates). Auth
 * is whatever the user already has configured for those tools — we don't store tokens.
 *
 * The body is passed through stdin (`gh issue edit --body-file -`, `glab issue update
 * --description-file -`) so embedded newlines / markdown / quotes round-trip cleanly.
 *
 * Errors:
 *  - CLI not installed → `StorageError(subCode: 'io', message: '<cli> not installed …')`
 *  - 4xx/5xx → `StorageError(subCode: 'io', message: '<cli> issue …: <stderr>')`
 *  - Timeout → `StorageError(subCode: 'io', message: '<cli> timed out …')`
 */

const CLI_TIMEOUT_MS = 30_000;

const updateGitHub = async (
  spawn: Spawn,
  url: string,
  body: string,
  parsed: { owner: string; repo: string; number: number }
): Promise<Result<void, StorageError>> => {
  // `gh issue edit <number> --repo <owner>/<repo> --body-file -` reads body from stdin.
  const r = await runCli(
    spawn,
    'gh',
    ['issue', 'edit', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--body-file', '-'],
    { stdin: body, timeoutMs: CLI_TIMEOUT_MS }
  );
  if (!r.ok) return Result.error(r.error);
  if (r.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `gh issue edit failed: ${r.value.stderr.trim() || 'unknown error'} (url=${url})`,
      })
    );
  }
  return Result.ok(undefined);
};

const updateGitLab = async (
  spawn: Spawn,
  url: string,
  body: string,
  parsed: { owner: string; repo: string; number: number }
): Promise<Result<void, StorageError>> => {
  // `glab issue update <number> --repo <owner>/<repo> --description <body>` — glab doesn't
  // accept the body via stdin, so we pass it as a flag value. Markdown / newlines survive
  // because spawn marshals each argv element as a separate exec arg (no shell parsing).
  const r = await runCli(
    spawn,
    'glab',
    ['issue', 'update', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--description', body],
    { timeoutMs: CLI_TIMEOUT_MS }
  );
  if (!r.ok) return Result.error(r.error);
  if (r.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `glab issue update failed: ${r.value.stderr.trim() || 'unknown error'} (url=${url})`,
      })
    );
  }
  return Result.ok(undefined);
};

const createGitHub = async (
  spawn: Spawn,
  origin: IssueOriginRef,
  title: string,
  body: string
): Promise<Result<{ readonly url: string }, StorageError>> => {
  const r = await runCli(
    spawn,
    'gh',
    ['issue', 'create', '--repo', `${origin.owner}/${origin.repo}`, '--title', title, '--body-file', '-'],
    { stdin: body, timeoutMs: CLI_TIMEOUT_MS }
  );
  if (!r.ok) return Result.error(r.error);
  if (r.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `gh issue create failed: ${r.value.stderr.trim() || 'unknown error'}`,
      })
    );
  }
  // gh prints the URL on stdout when successful.
  const url = extractUrl(r.value.stdout);
  if (url === undefined) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `gh issue create succeeded but no URL found in stdout: ${r.value.stdout.slice(0, 200)}`,
      })
    );
  }
  return Result.ok({ url });
};

const createGitLab = async (
  spawn: Spawn,
  origin: IssueOriginRef,
  title: string,
  body: string
): Promise<Result<{ readonly url: string }, StorageError>> => {
  const r = await runCli(
    spawn,
    'glab',
    ['issue', 'create', '--repo', `${origin.owner}/${origin.repo}`, '--title', title, '--description', body],
    { timeoutMs: CLI_TIMEOUT_MS }
  );
  if (!r.ok) return Result.error(r.error);
  if (r.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `glab issue create failed: ${r.value.stderr.trim() || 'unknown error'}`,
      })
    );
  }
  const url = extractUrl(r.value.stdout);
  if (url === undefined) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `glab issue create succeeded but no URL found in stdout: ${r.value.stdout.slice(0, 200)}`,
      })
    );
  }
  return Result.ok({ url });
};

/** First http(s) URL we find on stdout. Both gh and glab emit `https://…/issues/<n>` post-create. */
const extractUrl = (out: string): string | undefined => {
  const m = /(https?:\/\/\S+)/u.exec(out);
  return m?.[1];
};

export interface IssuePusherDeps {
  readonly spawn: Spawn;
}

export const createIssuePusher = (deps: IssuePusherDeps): IssuePusher => ({
  async update(url, { body }) {
    const parsed = parseIssueUrl(url);
    if (parsed === null) {
      return Result.error(
        new StorageError({
          subCode: 'parse',
          message: `unsupported issue URL: ${url}`,
        })
      );
    }
    if (parsed.host === 'github') return updateGitHub(deps.spawn, url, body, parsed);
    return updateGitLab(deps.spawn, url, body, parsed);
  },
  async create(origin, { title, body }) {
    if (origin.provider === 'github') return createGitHub(deps.spawn, origin, title, body);
    return createGitLab(deps.spawn, origin, title, body);
  },
});
