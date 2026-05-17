import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** Platform discovered from the repo's `origin` remote. */
export type PullRequestPlatform = 'github' | 'gitlab';

export interface PullRequestCreatorInput {
  readonly cwd: AbsolutePath;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

export interface PullRequestCreatorOutput {
  readonly url: string;
  readonly platform: PullRequestPlatform;
}

/**
 * Output port for creating a pull / merge request via the local platform CLI (`gh` for GitHub,
 * `glab` for GitLab). The adapter detects the platform from the repo's `origin` remote — the
 * core code never sees git URLs or `gh`/`glab` argv shapes.
 *
 * Failure modes (all surface as `StorageError`):
 *   - No `origin` remote configured.
 *   - Unrecognised host (neither GitHub nor GitLab).
 *   - CLI not installed / fails to launch.
 *   - CLI exits non-zero (auth, network, branch-not-pushed, etc.).
 *   - CLI succeeded but emitted no URL.
 *
 * No "soft fail" — a missing `gh`/`glab` is a hard error, unlike the issue fetcher where the
 * caller may choose to proceed without context. PR creation has no useful fallback.
 */
export type PullRequestCreator = (
  input: PullRequestCreatorInput
) => Promise<Result<PullRequestCreatorOutput, StorageError>>;

const HTTP_REMOTE_RE = /^https?:\/\/([^/]+)\//i;
const SSH_REMOTE_RE = /^(?:git\+ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/]/i;

/**
 * Pure helper — extract the hostname from a git remote URL. Returns null on shapes the regexes
 * don't match (e.g. local file paths, malformed URLs). Exposed for unit tests.
 */
export const parseRemoteHostname = (remoteUrl: string): string | null => {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;
  const httpMatch = HTTP_REMOTE_RE.exec(trimmed);
  if (httpMatch?.[1] !== undefined) return httpMatch[1];
  const sshMatch = SSH_REMOTE_RE.exec(trimmed);
  if (sshMatch?.[1] !== undefined) return sshMatch[1];
  return null;
};

/**
 * Pure helper — pick the platform from a remote URL. Hostname-only matching: ownership/path
 * is irrelevant for picking the CLI. Exposed for unit tests.
 *
 *   - hostname `github.com` (or any subdomain) → 'github'
 *   - hostname `gitlab.com`, starts with `gitlab.`, or contains `.gitlab.` → 'gitlab'
 *   - everything else → null (caller surfaces "unknown host")
 */
export const detectPullRequestPlatform = (remoteUrl: string): PullRequestPlatform | null => {
  const hostname = parseRemoteHostname(remoteUrl);
  if (hostname === null) return null;
  const lower = hostname.toLowerCase();
  if (lower === 'github.com' || lower.endsWith('.github.com')) return 'github';
  if (lower === 'gitlab.com' || lower.startsWith('gitlab.') || lower.includes('.gitlab.')) return 'gitlab';
  return null;
};

/**
 * Pure helper — pick the URL line from CLI stdout. Both `gh pr create` and `glab mr create`
 * print the URL on the last non-empty line. Prefers https:// lines explicitly so noisy
 * progress output doesn't fool the parser. Exposed for unit tests.
 */
export const parseUrlFromCliStdout = (stdout: string): string | null => {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && /^https?:\/\//.test(line)) return line;
  }
  return lines.at(-1) ?? null;
};
