import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IssuePusher, IssueTrackerOrigin } from '@src/business/scm/issue-pusher.ts';
import {
  detectPullRequestPlatform,
  parseRemoteHostname,
  parseUrlFromCliStdout,
} from '@src/business/scm/pull-request-creator.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { parseCliJson, requireCleanExit, runCli } from '@src/integration/io/run-cli.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { type GitLabIssueRef, listGitLabIssueNotes } from '@src/integration/scm/gitlab-notes.ts';
import { parseGitRemoteUrl, parseIssueUrl } from '@src/integration/scm/issue-fetcher.ts';

/**
 * CLI-backed `IssuePusher`. Same shape as {@link createIssueFetcher}: dispatches to `gh` or
 * `glab` based on the URL host (or, for create, the repo's `origin` remote). Auth is whatever
 * the user already has configured for those tools — we don't store tokens.
 *
 * The body is posted as a comment — the issue's own description is never modified. GitHub
 * reads the comment body from stdin (`gh issue comment --body-file -`) so embedded newlines /
 * markdown / quotes round-trip cleanly; glab takes it as a `--message` flag value (each argv
 * element is marshalled as a separate exec arg, so no shell parsing mangles it). GitLab notes are
 * listed via {@link listGitLabIssueNotes} (`glab api …/notes`) — glab has no note-listing subcommand.
 *
 * Errors:
 *  - CLI fails to launch → `StorageError(subCode: 'io', message: '<cli> failed to spawn: <cause>')`
 *  - 4xx/5xx → `StorageError(subCode: 'io', message: '<cli> issue …: <stderr>')`
 *  - Timeout → `StorageError(subCode: 'io', message: '<cli> timed out …')`
 */

const CLI_TIMEOUT_MS = 30_000;

interface GhComment {
  readonly body?: string;
}

interface GhIssueCommentsResponse {
  readonly comments?: readonly GhComment[];
}

const commentGitHub = async (
  spawn: Spawn,
  url: string,
  body: string,
  parsed: { owner: string; repo: string; number: number }
): Promise<Result<void, StorageError>> => {
  const r = await runCli(
    spawn,
    'gh',
    ['issue', 'comment', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--body-file', '-'],
    { stdin: body, timeoutMs: CLI_TIMEOUT_MS }
  );
  return requireCleanExit(r, 'gh issue comment', `url=${url}`).map(() => undefined);
};

const commentGitLab = async (
  spawn: Spawn,
  url: string,
  body: string,
  parsed: { hostname: string; owner: string; repo: string; number: number }
): Promise<Result<void, StorageError>> => {
  // glab has no stdin form for a comment, so the body rides `--message`. The host MUST prefix
  // `--repo`, or glab defaults to gitlab.com and a self-hosted issue 401s / 404s.
  const r = await runCli(
    spawn,
    'glab',
    [
      'issue',
      'comment',
      String(parsed.number),
      '--repo',
      `${parsed.hostname}/${parsed.owner}/${parsed.repo}`,
      '--message',
      body,
    ],
    { timeoutMs: CLI_TIMEOUT_MS }
  );
  return requireCleanExit(r, 'glab issue comment', `url=${url}`).map(() => undefined);
};

const resolveOriginFromGit = async (
  gitRunner: GitRunner,
  cwd: AbsolutePath
): Promise<Result<IssueTrackerOrigin | null, StorageError>> => {
  const result = await gitRunner.run(cwd, ['remote', 'get-url', 'origin']);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) return Result.ok(null);
  const url = result.value.stdout.trim();
  if (url.length === 0) return Result.ok(null);
  const parsed = parseGitRemoteUrl(url);
  if (parsed === null) return Result.ok(null);
  const platform = detectPullRequestPlatform(url);
  if (platform === null) return Result.ok(null);
  const hostname = parseRemoteHostname(url);
  if (hostname === null) return Result.ok(null);
  return Result.ok({
    provider: platform,
    hostname,
    owner: parsed.owner,
    repo: parsed.repo,
  });
};

const createGitHub = async (
  spawn: Spawn,
  origin: IssueTrackerOrigin,
  title: string,
  body: string
): Promise<Result<{ url: string }, StorageError>> => {
  const r = requireCleanExit(
    await runCli(
      spawn,
      'gh',
      ['issue', 'create', '--repo', `${origin.owner}/${origin.repo}`, '--title', title, '--body-file', '-'],
      { stdin: body, timeoutMs: CLI_TIMEOUT_MS }
    ),
    'gh issue create'
  );
  if (!r.ok) return Result.error(r.error);
  const url = parseUrlFromCliStdout(r.value.stdout);
  if (url === null) {
    return Result.error(new StorageError({ subCode: 'io', message: 'gh issue create succeeded but emitted no URL' }));
  }
  return Result.ok({ url });
};

const createGitLab = async (
  spawn: Spawn,
  origin: IssueTrackerOrigin,
  title: string,
  body: string
): Promise<Result<{ url: string }, StorageError>> => {
  // `--repo HOST/OWNER/REPO` so a self-hosted host is not sent to gitlab.com.
  const r = requireCleanExit(
    await runCli(
      spawn,
      'glab',
      [
        'issue',
        'create',
        '--repo',
        `${origin.hostname}/${origin.owner}/${origin.repo}`,
        '--title',
        title,
        '--description',
        body,
      ],
      { timeoutMs: CLI_TIMEOUT_MS }
    ),
    'glab issue create'
  );
  if (!r.ok) return Result.error(r.error);
  const url = parseUrlFromCliStdout(r.value.stdout);
  if (url === null) {
    return Result.error(new StorageError({ subCode: 'io', message: 'glab issue create succeeded but emitted no URL' }));
  }
  return Result.ok({ url });
};

const listGitHubComments = async (
  spawn: Spawn,
  parsed: { owner: string; repo: string; number: number }
): Promise<Result<readonly string[], StorageError>> => {
  const result = requireCleanExit(
    await runCli(
      spawn,
      'gh',
      [
        'issue',
        'view',
        String(parsed.number),
        '--repo',
        `${parsed.owner}/${parsed.repo}`,
        '--json',
        'title,body,state,url,comments',
      ],
      { timeoutMs: CLI_TIMEOUT_MS }
    ),
    'gh issue view'
  );
  if (!result.ok) return Result.error(result.error);
  return parseCliJson<GhIssueCommentsResponse>(result.value.stdout, 'gh issue').map((json) =>
    (json.comments ?? []).map((c) => c.body ?? '')
  );
};

const listGitLabComments = async (
  spawn: Spawn,
  parsed: GitLabIssueRef
): Promise<Result<readonly string[], StorageError>> =>
  (await listGitLabIssueNotes(spawn, parsed)).map((notes) => notes.map((n) => n.body));

const parseIssueUrlOrError = (url: string): Result<NonNullable<ReturnType<typeof parseIssueUrl>>, StorageError> => {
  const parsed = parseIssueUrl(url);
  return parsed === null
    ? Result.error(new StorageError({ subCode: 'parse', message: `unsupported issue URL: ${url}` }))
    : Result.ok(parsed);
};

export interface IssuePusherDeps {
  readonly spawn: Spawn;
  readonly gitRunner: GitRunner;
}

export const createIssuePusher = (deps: IssuePusherDeps): IssuePusher => ({
  async resolveOrigin(cwd) {
    return resolveOriginFromGit(deps.gitRunner, cwd);
  },

  async create({ cwd, title, body }) {
    const origin = await resolveOriginFromGit(deps.gitRunner, cwd);
    if (!origin.ok) return Result.error(origin.error);
    if (origin.value === null) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `no GitHub or GitLab origin at ${String(cwd)}`,
        })
      );
    }
    if (origin.value.provider === 'github') return createGitHub(deps.spawn, origin.value, title, body);
    return createGitLab(deps.spawn, origin.value, title, body);
  },

  async listComments(url) {
    const parsed = parseIssueUrlOrError(url);
    if (!parsed.ok) return Result.error(parsed.error);
    if (parsed.value.host === 'github') return listGitHubComments(deps.spawn, parsed.value);
    return listGitLabComments(deps.spawn, parsed.value);
  },

  async comment(url, { body }) {
    const parsed = parseIssueUrlOrError(url);
    if (!parsed.ok) return Result.error(parsed.error);
    if (parsed.value.host === 'github') return commentGitHub(deps.spawn, url, body, parsed.value);
    return commentGitLab(deps.spawn, url, body, parsed.value);
  },
});
