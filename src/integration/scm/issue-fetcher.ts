import { Result } from '@src/domain/result.ts';
import { type StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ExternalIssue, ExternalIssueComment, IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import { parseCliJson, requireCleanExit, runCli } from '@src/integration/io/run-cli.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { listGitLabIssueNotes } from '@src/integration/scm/gitlab-notes.ts';

/**
 * Filesystem-backed `IssueFetcher` that dispatches to the local `gh` (GitHub) or `glab`
 * (GitLab) CLI tools based on the URL host. Both tools handle auth via the user's existing
 * login — the harness doesn't store tokens.
 *
 * Result semantics:
 *   - `Result.ok(issue)` — fetched cleanly.
 *   - `Result.ok(null)`  — URL not recognised (unknown host) or issue not found / private.
 *   - `Result.error(StorageError)` — `gh`/`glab` not installed, malformed JSON, network error.
 *
 * Caller decides what to do with errors. For refine, the convention is "soft-fail": log a
 * warning and proceed without context.
 */

const CLI_TIMEOUT_MS = 30_000;
const MAX_COMMENTS = 20;

interface ParsedUrl {
  readonly host: 'github' | 'gitlab';
  /** The URL hostname (e.g. `gitlab.com`, `gitlab.example.internal`). Used to target self-hosted instances. */
  readonly hostname: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

interface GhComment {
  readonly author?: { readonly login?: string };
  readonly body?: string;
}

interface GhIssueResponse {
  readonly title?: string;
  readonly body?: string;
  readonly state?: string;
  readonly url?: string;
  readonly comments?: readonly GhComment[];
}

interface GlabIssueResponse {
  readonly title?: string;
  readonly description?: string;
  readonly state?: string;
  readonly web_url?: string;
}

/**
 * Parse a git remote URL into an {@link IssueOriginRef}-compatible shape. Accepts the three
 * common forms a `git remote get-url origin` emits:
 *   - HTTPS:   `https://github.com/owner/repo.git`
 *   - SSH:     `git@github.com:owner/repo.git`
 *   - SSH URI: `ssh://git@gitlab.example.com/owner/repo.git`
 *
 * Returns `null` for shapes we don't recognise. `provider` is detected from the host:
 *   - hostname containing `github` → `'github'`
 *   - everything else → `'gitlab'` (since the supported provider universe is github+gitlab,
 *     self-hosted GitLab instances on custom domains land here).
 *
 * Trailing `.git` is stripped from `repo` per convention.
 */
export const parseGitRemoteUrl = (
  url: string
): { readonly provider: 'github' | 'gitlab'; readonly owner: string; readonly repo: string } | null => {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  // SSH shorthand: git@host:owner/repo(.git)?
  const sshShort = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):([^/]+)\/(.+?)(\.git)?$/u.exec(trimmed);
  if (sshShort !== null) {
    const host = sshShort[1]!;
    const owner = sshShort[2]!;
    const repo = sshShort[3]!;
    return { provider: host.includes('github') ? 'github' : 'gitlab', owner, repo };
  }
  // URL-like (https://, ssh://, git://)
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const segments = parsed.pathname
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1];
  // GitLab supports groups (multi-segment owner). Treat everything before the final segment as
  // the owner path joined by `/`. For github (`/owner/repo`), this collapses to just `owner`.
  const owner = segments.slice(0, -1).join('/');
  if (owner.length === 0 || repo === undefined || repo.length === 0) return null;
  const host = parsed.hostname;
  return { provider: host.includes('github') ? 'github' : 'gitlab', owner, repo };
};

/** Match GitHub's `/<owner>/<repo>/issues/<number>` issue-URL path shape. */
const parseGitHubIssuePath = (segments: readonly string[], hostname: string): ParsedUrl | null => {
  if (segments.length >= 4 && segments[2] === 'issues') {
    const owner = segments[0];
    const repo = segments[1];
    const num = Number(segments[3]);
    if (owner && repo && Number.isInteger(num) && num > 0) {
      return { host: 'github', hostname, owner, repo, number: num };
    }
  }
  return null;
};

/**
 * Match GitLab's `/<group...>/<project>/-/issues/<number>` issue-URL path shape — also accepts
 * the `work_items` path. Since GitLab 16 issues are work items sharing one iid namespace, a
 * `/-/work_items/N` URL resolves to the same issue as `/-/issues/N` and `glab issue view N`
 * fetches both.
 */
const parseGitLabIssuePath = (segments: readonly string[], hostname: string): ParsedUrl | null => {
  const dashIdx = segments.indexOf('-');
  const kind = dashIdx >= 0 ? segments[dashIdx + 1] : undefined;
  if (dashIdx >= 2 && (kind === 'issues' || kind === 'work_items')) {
    const num = Number(segments[dashIdx + 2]);
    const repo = segments[dashIdx - 1];
    if (repo && Number.isInteger(num) && num > 0) {
      const owner = segments.slice(0, dashIdx - 1).join('/');
      return { host: 'gitlab', hostname, owner, repo, number: num };
    }
  }
  return null;
};

/** Parse a GitHub or GitLab issue URL. Returns null for unrecognised shapes. */
export const parseIssueUrl = (url: string): ParsedUrl | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname === 'github.com') return parseGitHubIssuePath(segments, parsed.hostname);
  return parseGitLabIssuePath(segments, parsed.hostname);
};

/**
 * The `--repo` argument for `glab`. Fully-qualified as `HOST/OWNER/REPO` so the CLI targets the
 * right instance — without the host, `glab` silently defaults to `gitlab.com` and an issue on a
 * self-hosted host (e.g. `gitlab.example.internal`) 401s / 404s against the wrong server.
 */
const glabRepoArg = (parsed: ParsedUrl): string => `${parsed.hostname}/${parsed.owner}/${parsed.repo}`;

const looksLikeNotFound = (stderr: string): boolean => {
  const s = stderr.toLowerCase();
  return (
    s.includes('not found') || s.includes('404') || s.includes('could not resolve') || s.includes('does not exist')
  );
};

const fetchGitHub = async (
  spawn: Spawn,
  parsed: ParsedUrl,
  url: string
): Promise<Result<ExternalIssue | null, StorageError>> => {
  const result = await runCli(
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
  );
  if (result.ok && result.value.exitCode !== 0 && looksLikeNotFound(result.value.stderr)) return Result.ok(null);
  const checked = requireCleanExit(result, 'gh issue view');
  if (!checked.ok) return Result.error(checked.error);
  const json = parseCliJson<GhIssueResponse>(checked.value.stdout, 'gh issue');
  if (!json.ok) return Result.error(json.error);
  const parsedJson = json.value;
  const comments: ExternalIssueComment[] = (parsedJson.comments ?? []).slice(-MAX_COMMENTS).map((c) => ({
    author: c.author?.login ?? 'unknown',
    body: c.body ?? '',
  }));
  return Result.ok({
    url: parsedJson.url ?? url,
    title: parsedJson.title ?? '',
    body: parsedJson.body ?? '',
    state: (parsedJson.state ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open',
    comments,
  });
};

/**
 * Best-effort fetch of issue notes via {@link listGitLabIssueNotes}. Never throws — every
 * failure mode (spawn error, non-zero exit, malformed JSON) collapses to
 * `{ comments: [], failure: <description> }` so `fetchGitLab` can still return the issue body
 * and let the caller log a warning. The helper drops system notes and sorts oldest-first; the
 * tail is sliced to {@link MAX_COMMENTS} so the GitLab adapter matches the "last 20" behaviour
 * of {@link fetchGitHub}.
 */
const fetchGitLabNotes = async (
  spawn: Spawn,
  parsed: ParsedUrl
): Promise<{ readonly comments: ExternalIssueComment[]; readonly failure?: string }> => {
  const notes = await listGitLabIssueNotes(spawn, parsed);
  if (!notes.ok) return { comments: [], failure: notes.error.message };
  const comments = notes.value.slice(-MAX_COMMENTS).map<ExternalIssueComment>((n) => ({
    author: n.author ?? 'unknown',
    body: n.body,
  }));
  return { comments };
};

const fetchGitLab = async (
  spawn: Spawn,
  parsed: ParsedUrl,
  url: string,
  logger: Logger | undefined
): Promise<Result<ExternalIssue | null, StorageError>> => {
  const result = await runCli(
    spawn,
    'glab',
    ['issue', 'view', String(parsed.number), '--repo', glabRepoArg(parsed), '--output', 'json'],
    { timeoutMs: CLI_TIMEOUT_MS }
  );
  if (result.ok && result.value.exitCode !== 0 && looksLikeNotFound(result.value.stderr)) return Result.ok(null);
  const checked = requireCleanExit(result, 'glab issue view');
  if (!checked.ok) return Result.error(checked.error);
  const json = parseCliJson<GlabIssueResponse>(checked.value.stdout, 'glab issue');
  if (!json.ok) return Result.error(json.error);
  const parsedJson = json.value;
  const notes = await fetchGitLabNotes(spawn, parsed);
  if (notes.failure !== undefined) {
    logger?.warn(`could not list GitLab notes for ${url}: ${notes.failure} — proceeding without comments`);
  }
  return Result.ok({
    url: parsedJson.web_url ?? url,
    title: parsedJson.title ?? '',
    body: parsedJson.description ?? '',
    state: (parsedJson.state ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open',
    comments: notes.comments,
  });
};

export interface IssueFetcherDeps {
  readonly spawn: Spawn;
  readonly logger?: Logger;
}

export const createIssueFetcher =
  (deps: IssueFetcherDeps): IssueFetcher =>
  async (url) => {
    const parsed = parseIssueUrl(url);
    if (parsed === null) return Result.ok(null);
    if (parsed.host === 'github') return fetchGitHub(deps.spawn, parsed, url);
    return fetchGitLab(deps.spawn, parsed, url, deps.logger);
  };

// `formatIssueContext` lives in `core/external/issue-fetcher.ts` (pure formatter, layer-neutral).
