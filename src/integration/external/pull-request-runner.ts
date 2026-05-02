/**
 * `PullRequestRunner` — opens a pull / merge request via the platform CLI
 * (`gh` for GitHub, `glab` for GitLab) detected from a git remote URL.
 *
 * The runner is split out from {@link IssueFetcher} on purpose: the two
 * surfaces share the platform-detection idea but the argv shapes diverge
 * enough that one big switch is harder to read than two focused helpers.
 *
 * Detection rules (intentionally narrow):
 *  - hostname `github.com` (or any subdomain of `github.com`) → `gh pr create`.
 *  - hostname matches `gitlab.com` OR starts with `gitlab.` (self-hosted
 *    convention) → `glab mr create`.
 *  - everything else → `Result.error(StorageError(io))` with a hint to
 *    install `gh` or `glab` and configure a recognised remote.
 *
 * The seam is the same `spawnSync` call IssueFetcher uses — each platform
 * CLI is invoked with literal args (no shell), with a fixed timeout. The
 * URL is parsed from the CLI's last non-empty stdout line (both `gh` and
 * `glab` print the URL there).
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

const CLI_TIMEOUT_MS = 60_000;
const HTTP_REMOTE_RE = /^https?:\/\/([^/]+)\//i;
const SSH_REMOTE_RE = /^(?:git\+ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/]/i;

/** Platform discovered from the remote URL — null when none matched. */
export type PullRequestPlatform = 'github' | 'gitlab';

/** Inputs to {@link PullRequestRunner.create}. */
export interface PullRequestRunnerInput {
  readonly cwd: AbsolutePath;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
}

/** Output of {@link PullRequestRunner.create}. */
export interface PullRequestRunnerOutput {
  readonly url: string;
  readonly platform: PullRequestPlatform;
}

/**
 * Spawn shape — narrow to what we actually use. `IssueFetcher` reaches
 * directly for `spawnSync`; this module follows the same pattern so the
 * test seam is `vi.mock('node:child_process')` rather than yet another
 * port.
 */
type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions
) => { readonly status: number | null; readonly stdout: string | Buffer; readonly stderr: string | Buffer };

/**
 * Detect the host platform from a remote URL string.
 *
 *   - HTTPS: `https://github.com/foo/bar.git`
 *   - SSH:  `git@github.com:foo/bar.git`
 *
 * Matching is hostname-only — ownership / path is irrelevant for picking
 * the CLI.
 */
export function detectPlatform(remoteUrl: string): PullRequestPlatform | null {
  const hostname = parseHostname(remoteUrl);
  if (hostname === null) return null;
  const lower = hostname.toLowerCase();
  if (lower === 'github.com' || lower.endsWith('.github.com')) return 'github';
  if (lower === 'gitlab.com' || lower.startsWith('gitlab.') || lower.includes('.gitlab.')) return 'gitlab';
  return null;
}

function parseHostname(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;
  const httpMatch = HTTP_REMOTE_RE.exec(trimmed);
  if (httpMatch?.[1]) return httpMatch[1];
  const sshMatch = SSH_REMOTE_RE.exec(trimmed);
  if (sshMatch?.[1]) return sshMatch[1];
  return null;
}

/** Pick the last non-empty trimmed line from CLI stdout — the URL line. */
function parseUrlFromStdout(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && /^https?:\/\//.test(line)) return line;
  }
  // Fallback — last non-empty line even if it doesn't parse as a URL.
  return lines.at(-1) ?? null;
}

/** Wrap `result.stdout / stderr` (which can be Buffer | string) as a string. */
function asString(buf: string | Buffer): string {
  return typeof buf === 'string' ? buf : buf.toString('utf-8');
}

export class PullRequestRunner {
  /** @param spawn Override seam — defaults to `node:child_process.spawnSync`. */
  constructor(private readonly spawn: SpawnFn = spawnSync) {}

  create(input: PullRequestRunnerInput): Result<PullRequestRunnerOutput, StorageError> {
    const platform = detectPlatform(input.remoteUrl);
    if (platform === null) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `Unknown git host '${input.remoteUrl}' — install gh or glab and configure a github/gitlab remote`,
        })
      );
    }
    return platform === 'github' ? this.runGh(input) : this.runGlab(input);
  }

  private runGh(input: PullRequestRunnerInput): Result<PullRequestRunnerOutput, StorageError> {
    const args: string[] = [
      'pr',
      'create',
      '--base',
      input.base,
      '--head',
      input.branch,
      '--title',
      input.title,
      '--body',
      input.body,
    ];
    if (input.draft === true) args.push('--draft');

    const r = this.spawn('gh', args, {
      cwd: input.cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
    });

    if (r.status === null) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `gh pr create failed to launch (is gh installed?): ${asString(r.stderr).trim()}`,
        })
      );
    }
    if (r.status !== 0) {
      const stderr = asString(r.stderr).trim();
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `gh pr create failed: ${stderr || 'unknown error'}`,
        })
      );
    }
    const url = parseUrlFromStdout(asString(r.stdout));
    if (url === null) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: 'gh pr create succeeded but emitted no URL',
        })
      );
    }
    return Result.ok({ url, platform: 'github' });
  }

  private runGlab(input: PullRequestRunnerInput): Result<PullRequestRunnerOutput, StorageError> {
    const args: string[] = [
      'mr',
      'create',
      '--target-branch',
      input.base,
      '--source-branch',
      input.branch,
      '--title',
      input.title,
      '--description',
      input.body,
    ];
    if (input.draft === true) args.push('--draft');

    const r = this.spawn('glab', args, {
      cwd: input.cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
    });

    if (r.status === null) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `glab mr create failed to launch (is glab installed?): ${asString(r.stderr).trim()}`,
        })
      );
    }
    if (r.status !== 0) {
      const stderr = asString(r.stderr).trim();
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `glab mr create failed: ${stderr || 'unknown error'}`,
        })
      );
    }
    const url = parseUrlFromStdout(asString(r.stdout));
    if (url === null) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: 'glab mr create succeeded but emitted no URL',
        })
      );
    }
    return Result.ok({ url, platform: 'gitlab' });
  }
}
