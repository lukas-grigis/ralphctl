/**
 * `IssueFetcher` — fetches issue data from GitHub or GitLab via the
 * platform's CLI tool (`gh` or `glab`) and formats it as markdown for
 * AI prompt context.
 *
 * URL parsing is shared between platforms — we detect the host from the
 * hostname and the path shape, then dispatch to the platform-specific
 * fetch logic.
 *
 * Result semantics (per port spec):
 *  - `Result.ok(issue)` — fetched cleanly.
 *  - `Result.ok(null)`  — URL is well-formed but the issue couldn't be
 *                         resolved (e.g. unrecognised URL, 404). Treated
 *                         as a normal "no such thing" outcome.
 *  - `Result.error(StorageError)` — system-level failure: CLI tool not
 *                         installed, malformed JSON in the response, etc.
 *
 * The {@link GitRunner} is injected for parity with the rest of the
 * external-adapter wiring — issue fetching uses different binaries
 * (`gh` / `glab`), so we still spawn them directly via `spawnSync`. The
 * runner is kept on the constructor so a future seam refactor (one
 * unified `ProcessSpawner` port) can land without changing the public
 * shape of this class.
 */
import { spawnSync } from 'node:child_process';

import type { ExternalIssue } from '@src/business/ports/external-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { GitRunner } from './git-runner.ts';

const MAX_COMMENTS = 20;
const CLI_TIMEOUT_MS = 30_000;

interface ParsedIssueUrl {
  readonly host: 'github' | 'gitlab';
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
  readonly comments?: readonly GhComment[];
}

interface GlabNote {
  readonly author?: { readonly username?: string };
  readonly body?: string;
}

interface GlabIssueResponse {
  readonly title?: string;
  readonly description?: string;
  readonly state?: string;
}

/** Parse a GitHub or GitLab issue URL into its components. */
export function parseIssueUrl(url: string): ParsedIssueUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);

  if (parsed.hostname === 'github.com') {
    const owner = segments[0];
    const repo = segments[1];
    if (segments.length >= 4 && segments[2] === 'issues' && owner && repo) {
      const num = Number(segments[3]);
      if (Number.isInteger(num) && num > 0) {
        return {
          host: 'github',
          hostname: parsed.hostname,
          owner,
          repo,
          number: num,
        };
      }
    }
    return null;
  }

  // GitLab: /.../group/project/-/issues/123
  const dashIdx = segments.indexOf('-');
  if (dashIdx >= 2 && segments[dashIdx + 1] === 'issues') {
    const num = Number(segments[dashIdx + 2]);
    if (Number.isInteger(num) && num > 0) {
      const repo = segments[dashIdx - 1];
      if (repo) {
        const owner = segments.slice(0, dashIdx - 1).join('/');
        return {
          host: 'gitlab',
          hostname: parsed.hostname,
          owner,
          repo,
          number: num,
        };
      }
    }
  }

  return null;
}

function looksLikeNotFound(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('not found') || s.includes('404') || s.includes('could not resolve') || s.includes('does not exist')
  );
}

function checkCliAvailable(cli: 'gh' | 'glab'): boolean {
  const probe = spawnSync(cli, ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return probe.status === 0;
}

export class IssueFetcher {
  /**
   * @param _git Reserved for a future unified process-spawn seam. The
   *   constructor takes it for parity with the rest of the external
   *   adapter wiring; the current implementation spawns `gh` / `glab`
   *   directly via {@link spawnSync}.
   */
  constructor(_git: GitRunner) {
    // Intentionally unused — see jsdoc above.
    void _git;
  }

  fetch(url: string): Promise<Result<ExternalIssue | null, StorageError>> {
    const parsed = parseIssueUrl(url);
    if (!parsed) return Promise.resolve(Result.ok(null));

    if (parsed.host === 'github') {
      return Promise.resolve(this.fetchGitHub(parsed));
    }
    return Promise.resolve(this.fetchGitLab(parsed));
  }

  format(issue: ExternalIssue): string {
    const lines: string[] = [];
    lines.push('## Source Issue Data');
    lines.push('');
    lines.push(`**Title:** ${issue.title}`);
    if (issue.state) {
      lines.push(`**State:** ${issue.state}`);
    }
    lines.push('');

    if (issue.body) {
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
  }

  // --- platform-specific fetchers --------------------------------------

  private fetchGitHub(parsed: ParsedIssueUrl): Result<ExternalIssue | null, StorageError> {
    if (!checkCliAvailable('gh')) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: 'gh/glab not installed — cannot fetch github issue',
        })
      );
    }

    const r = spawnSync(
      'gh',
      [
        'issue',
        'view',
        String(parsed.number),
        '--repo',
        `${parsed.owner}/${parsed.repo}`,
        '--json',
        'title,body,state,comments',
      ],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: CLI_TIMEOUT_MS,
      }
    );
    if (r.status !== 0) {
      const stderr = (r.stderr || '').trim();
      if (looksLikeNotFound(stderr)) return Result.ok(null);
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `gh issue view failed: ${stderr || 'unknown error'}`,
        })
      );
    }

    try {
      const data = JSON.parse(r.stdout) as GhIssueResponse;
      const comments: ExternalIssue['comments'] = (data.comments ?? []).slice(-MAX_COMMENTS).map((c) => ({
        author: c.author?.login ?? 'unknown',
        body: c.body ?? '',
      }));
      return Result.ok({
        title: data.title ?? '',
        body: data.body ?? '',
        state: data.state ?? '',
        comments,
      });
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'parse',
          message: `failed to parse gh issue response: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        })
      );
    }
  }

  private fetchGitLab(parsed: ParsedIssueUrl): Result<ExternalIssue | null, StorageError> {
    if (!checkCliAvailable('glab')) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: 'gh/glab not installed — cannot fetch gitlab issue',
        })
      );
    }

    const r = spawnSync(
      'glab',
      ['issue', 'view', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--output', 'json'],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: CLI_TIMEOUT_MS,
      }
    );
    if (r.status !== 0) {
      const stderr = (r.stderr || '').trim();
      if (looksLikeNotFound(stderr)) return Result.ok(null);
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `glab issue view failed: ${stderr || 'unknown error'}`,
        })
      );
    }

    let data: GlabIssueResponse;
    try {
      data = JSON.parse(r.stdout) as GlabIssueResponse;
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'parse',
          message: `failed to parse glab issue response: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        })
      );
    }

    // Best-effort: comments come from a separate command. If notes fail
    // we still return the issue body.
    const notesR = spawnSync(
      'glab',
      ['issue', 'note', 'list', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--output', 'json'],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: CLI_TIMEOUT_MS,
      }
    );

    let comments: ExternalIssue['comments'] = [];
    if (notesR.status === 0 && notesR.stdout.trim()) {
      try {
        const notes = JSON.parse(notesR.stdout) as GlabNote[];
        comments = notes.slice(-MAX_COMMENTS).map((n) => ({
          author: n.author?.username ?? 'unknown',
          body: n.body ?? '',
        }));
      } catch {
        // Non-fatal — return issue body without comments.
      }
    }

    return Result.ok({
      title: data.title ?? '',
      body: data.description ?? '',
      state: data.state ?? '',
      comments,
    });
  }
}
