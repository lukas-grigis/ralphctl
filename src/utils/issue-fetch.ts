import { spawnSync } from 'node:child_process';
import { Result } from 'typescript-result';
import { IssueFetchError } from '@src/errors.ts';
import { unwrapOrThrow } from '@src/utils/result-helpers.ts';

export { IssueFetchError } from '@src/errors.ts';

const MAX_COMMENTS = 20;

export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface IssueData {
  title: string;
  body: string;
  comments: IssueComment[];
  url: string;
}

export interface ParsedIssueUrl {
  host: 'github' | 'gitlab';
  hostname: string;
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parse a GitHub or GitLab issue URL into its components.
 * Returns null if the URL is not a recognized issue URL.
 *
 * GitHub: https://github.com/owner/repo/issues/123
 * GitLab: https://gitlab.example.com/group/project/-/issues/456
 *         (any hostname with /-/issues/ path segment)
 */
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

  // GitHub: /owner/repo/issues/123
  if (parsed.hostname === 'github.com') {
    const owner = segments[0];
    const repo = segments[1];
    if (segments.length >= 4 && segments[2] === 'issues' && owner && repo) {
      const num = Number(segments[3]);
      if (Number.isInteger(num) && num > 0) {
        return { host: 'github', hostname: parsed.hostname, owner, repo, number: num };
      }
    }
    return null;
  }

  // GitLab (any hostname): /.../group/project/-/issues/456
  const dashIdx = segments.indexOf('-');
  if (dashIdx >= 2 && segments[dashIdx + 1] === 'issues') {
    const num = Number(segments[dashIdx + 2]);
    if (Number.isInteger(num) && num > 0) {
      const repo = segments[dashIdx - 1];
      if (repo) {
        const owner = segments.slice(0, dashIdx - 1).join('/');
        return { host: 'gitlab', hostname: parsed.hostname, owner, repo, number: num };
      }
    }
  }

  return null;
}

interface GhComment {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
}

interface GhIssueResponse {
  title?: string;
  body?: string;
  comments?: GhComment[];
}

interface GlabNote {
  author?: { username?: string };
  body?: string;
  created_at?: string;
}

interface GlabIssueResponse {
  title?: string;
  description?: string;
  notes?: GlabNote[];
}

function fetchGitHubIssueResult(parsed: ParsedIssueUrl) {
  const result = spawnSync(
    'gh',
    [
      'issue',
      'view',
      String(parsed.number),
      '--repo',
      `${parsed.owner}/${parsed.repo}`,
      '--json',
      'title,body,comments',
    ],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 }
  );

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    return Result.error(new IssueFetchError(`gh issue view failed: ${stderr || 'unknown error'}`));
  }

  const data = JSON.parse(result.stdout) as GhIssueResponse;

  const comments: IssueComment[] = (data.comments ?? []).slice(-MAX_COMMENTS).map((c) => ({
    author: c.author?.login ?? 'unknown',
    createdAt: c.createdAt ?? '',
    body: c.body ?? '',
  }));

  return Result.ok<IssueData>({
    title: data.title ?? '',
    body: data.body ?? '',
    comments,
    url: `https://${parsed.hostname}/${parsed.owner}/${parsed.repo}/issues/${String(parsed.number)}`,
  });
}

function fetchGitLabIssueResult(parsed: ParsedIssueUrl) {
  // Fetch issue details
  const result = spawnSync(
    'glab',
    ['issue', 'view', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--output', 'json'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 }
  );

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    return Result.error(new IssueFetchError(`glab issue view failed: ${stderr || 'unknown error'}`));
  }

  const data = JSON.parse(result.stdout) as GlabIssueResponse;

  // Fetch issue notes (comments) separately
  const notesResult = spawnSync(
    'glab',
    ['issue', 'note', 'list', String(parsed.number), '--repo', `${parsed.owner}/${parsed.repo}`, '--output', 'json'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 }
  );

  let comments: IssueComment[] = [];
  if (notesResult.status === 0 && notesResult.stdout.trim()) {
    try {
      const notes = JSON.parse(notesResult.stdout) as GlabNote[];
      comments = notes.slice(-MAX_COMMENTS).map((n) => ({
        author: n.author?.username ?? 'unknown',
        createdAt: n.created_at ?? '',
        body: n.body ?? '',
      }));
    } catch {
      // Non-fatal — continue without comments
    }
  }

  return Result.ok<IssueData>({
    title: data.title ?? '',
    body: data.description ?? '',
    comments,
    url: `https://${parsed.hostname}/${parsed.owner}/${parsed.repo}/-/issues/${String(parsed.number)}`,
  });
}

/**
 * Fetch issue data from GitHub or GitLab using CLI tools — Result-returning version.
 */
export function fetchIssueResult(parsed: ParsedIssueUrl) {
  if (parsed.host === 'github') {
    return fetchGitHubIssueResult(parsed);
  }
  return fetchGitLabIssueResult(parsed);
}

/**
 * Fetch issue data from GitHub or GitLab using CLI tools.
 * Throws IssueFetchError on failure.
 */
export function fetchIssue(parsed: ParsedIssueUrl): IssueData {
  return unwrapOrThrow(fetchIssueResult(parsed));
}

/**
 * Fetch issue data from a URL string — Result-returning version.
 * Returns null if the URL is not a recognized issue URL.
 */
export function fetchIssueFromUrlResult(url: string) {
  const parsed = parseIssueUrl(url);
  if (!parsed) return null;
  return fetchIssueResult(parsed);
}

/**
 * Fetch issue data from a URL string. Convenience wrapper around parseIssueUrl + fetchIssue.
 * Returns null if the URL is not a recognized issue URL.
 * Throws IssueFetchError on fetch failure.
 */
export function fetchIssueFromUrl(url: string): IssueData | null {
  const parsed = parseIssueUrl(url);
  if (!parsed) return null;
  return fetchIssue(parsed);
}

/**
 * Format issue data as markdown context for AI prompts.
 */
export function formatIssueContext(data: IssueData): string {
  const lines: string[] = [];

  lines.push('## Source Issue Data');
  lines.push('');
  lines.push(`> Fetched live from ${data.url}`);
  lines.push('');
  lines.push(`**Title:** ${data.title}`);
  lines.push('');

  if (data.body) {
    lines.push('**Body:**');
    lines.push('');
    lines.push(data.body);
    lines.push('');
  }

  if (data.comments.length > 0) {
    lines.push(`**Comments (${String(data.comments.length)}):**`);
    lines.push('');
    for (const comment of data.comments) {
      const timestamp = comment.createdAt ? ` (${comment.createdAt})` : '';
      lines.push(`---`);
      lines.push(`**@${comment.author}**${timestamp}:`);
      lines.push('');
      lines.push(comment.body);
      lines.push('');
    }
  }

  return lines.join('\n');
}
