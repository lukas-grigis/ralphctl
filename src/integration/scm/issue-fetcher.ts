import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { ExternalIssue, ExternalIssueComment, IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import { runCli } from '@src/integration/io/run-cli.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

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
const UNKNOWN_ERROR = 'unknown error';

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

interface GlabNote {
  readonly body?: string;
  readonly author?: { readonly username?: string };
  readonly system?: boolean;
  readonly created_at?: string;
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

  if (parsed.hostname === 'github.com') {
    // /<owner>/<repo>/issues/<number>
    if (segments.length >= 4 && segments[2] === 'issues') {
      const owner = segments[0];
      const repo = segments[1];
      const num = Number(segments[3]);
      if (owner && repo && Number.isInteger(num) && num > 0) {
        return { host: 'github', hostname: parsed.hostname, owner, repo, number: num };
      }
    }
    return null;
  }

  // GitLab: /<group...>/<project>/-/issues/<number> — also accept the `work_items` path.
  // Since GitLab 16 issues are work items sharing one iid namespace, so a `/-/work_items/N`
  // URL resolves to the same issue as `/-/issues/N` and `glab issue view N` fetches both.
  const dashIdx = segments.indexOf('-');
  const kind = dashIdx >= 0 ? segments[dashIdx + 1] : undefined;
  if (dashIdx >= 2 && (kind === 'issues' || kind === 'work_items')) {
    const num = Number(segments[dashIdx + 2]);
    const repo = segments[dashIdx - 1];
    if (repo && Number.isInteger(num) && num > 0) {
      const owner = segments.slice(0, dashIdx - 1).join('/');
      return { host: 'gitlab', hostname: parsed.hostname, owner, repo, number: num };
    }
  }

  return null;
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
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    if (looksLikeNotFound(result.value.stderr)) return Result.ok(null);
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `gh issue view failed: ${result.value.stderr.trim() || UNKNOWN_ERROR}`,
      })
    );
  }
  let parsedJson: GhIssueResponse;
  try {
    // Why: `gh issue view --json` output is shape-narrowed via the `GhIssueResponse`
    // interface with every field optional + nullable-checked at each use-site below
    // (`?.` / `?? ''`). A missing or malformed field collapses to the default rather
    // than throwing — sufficient for a best-effort issue fetch.
    parsedJson = JSON.parse(result.value.stdout) as GhIssueResponse;
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `failed to parse gh issue response`,
        cause,
      })
    );
  }
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
 * Best-effort fetch of issue notes via `glab issue note list`. Never throws —
 * every failure mode (spawn error, non-zero exit, malformed JSON) collapses to
 * `{ comments: [], failure: <description> }` so `fetchGitLab` can still return
 * the issue body and let the caller log a warning.
 *
 * System notes (label changes, assignments, …) are filtered out — they are
 * noise for refinement. Remaining notes are sorted oldest-first by
 * `created_at` (defensive — `glab` order is not contractually stable) and the
 * tail is sliced to {@link MAX_COMMENTS} so the GitLab adapter matches the
 * "last 20" behaviour of {@link fetchGitHub}.
 */
const fetchGitLabNotes = async (
  spawn: Spawn,
  parsed: ParsedUrl
): Promise<{ readonly comments: ExternalIssueComment[]; readonly failure?: string }> => {
  const result = await runCli(
    spawn,
    'glab',
    ['issue', 'note', 'list', String(parsed.number), '--repo', glabRepoArg(parsed), '--output', 'json'],
    { timeoutMs: CLI_TIMEOUT_MS }
  );
  if (!result.ok) return { comments: [], failure: result.error.message };
  if (result.value.exitCode !== 0) {
    return {
      comments: [],
      failure: `glab issue note list exited ${String(result.value.exitCode)}: ${result.value.stderr.trim() || UNKNOWN_ERROR}`,
    };
  }
  let notes: readonly GlabNote[];
  try {
    // Why: `glab issue note list --output json` produces an array of records that we
    // narrow via the `GlabNote` interface with every field optional; downstream `?.` /
    // `?? ''` access tolerates missing fields. Non-array payloads still parse, then
    // `.filter()` / `.sort()` no-op cleanly.
    notes = JSON.parse(result.value.stdout) as readonly GlabNote[];
  } catch (cause) {
    return {
      comments: [],
      failure: `failed to parse glab issue note list response: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const filtered = notes.filter((n) => n.system !== true);
  const sorted = [...filtered].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  const comments = sorted.slice(-MAX_COMMENTS).map<ExternalIssueComment>((n) => ({
    author: n.author?.username ?? 'unknown',
    body: n.body ?? '',
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
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    if (looksLikeNotFound(result.value.stderr)) return Result.ok(null);
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `glab issue view failed: ${result.value.stderr.trim() || UNKNOWN_ERROR}`,
      })
    );
  }
  let parsedJson: GlabIssueResponse;
  try {
    // Why: `glab issue view --output json` is shape-narrowed via the `GlabIssueResponse`
    // interface with every field optional + nullable-checked at each use-site below.
    parsedJson = JSON.parse(result.value.stdout) as GlabIssueResponse;
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `failed to parse glab issue response`,
        cause,
      })
    );
  }
  const notes = await fetchGitLabNotes(spawn, parsed);
  if (notes.failure !== undefined) {
    logger?.warn(`glab issue note list failed for ${url}: ${notes.failure} — proceeding without comments`);
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
