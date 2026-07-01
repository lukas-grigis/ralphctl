import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { crossPlatformSpawn } from '@src/integration/io/cross-platform-spawn.ts';

/**
 * Async wrapper around `git` invocations. Pure transport: no shell expansion, no
 * git-specific knowledge. Higher-level operations (`git-operations.ts`) translate argv lists
 * into typed results.
 *
 * Result semantics:
 *   - `Result.ok({ stdout, stderr, exitCode })` whenever git completed (zero or non-zero).
 *     Callers decide what a non-zero exit means in context.
 *   - `Result.error(StorageError({ subCode: 'io' }))` for system-level failures: spawn
 *     errors, timeouts, killed processes. Pure-read git ops in `git-operations.ts` typically
 *     map these back to safe defaults.
 *
 * No shell — args go through argv, so quotes / `$` / backticks / newlines are preserved
 * verbatim without expansion.
 */

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/**
 * Hard cap on buffered git command output. Git command output — notably `git diff HEAD` for the
 * work-product fingerprint — is capped so a huge AI-generated diff can't OOM the heap; mirrors
 * shell-script-runner's `MAX_OUTPUT_BYTES`. Once stdout exceeds this ceiling the child is killed
 * and a truncation marker is appended; callers degrade gracefully (the fingerprint hashes the
 * truncated diff deterministically — an exemption input, never a correctness gate).
 */
export const GIT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export interface GitRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitRunOptions {
  readonly timeoutMs?: number;
}

export interface GitRunner {
  run(cwd: AbsolutePath, args: readonly string[], opts?: GitRunOptions): Promise<Result<GitRunResult, StorageError>>;
}

export interface GitRunnerDeps {
  readonly spawn?: Spawn;
  readonly defaultTimeoutMs?: number;
  /**
   * Output-buffer cap. Defaults to {@link GIT_MAX_OUTPUT_BYTES}. Injectable so tests can drive a
   * tiny cap instead of generating 50 MB of fake stdout.
   */
  readonly maxOutputBytes?: number;
}

export const createGitRunner = (deps: GitRunnerDeps = {}): GitRunner => {
  const spawn = deps.spawn ?? defaultSpawn;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes = deps.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES;

  const run = (
    cwd: AbsolutePath,
    args: readonly string[],
    opts: GitRunOptions = {}
  ): Promise<Result<GitRunResult, StorageError>> =>
    runGitOnce(spawn, cwd, args, opts.timeoutMs ?? defaultTimeoutMs, maxOutputBytes);

  return { run };
};

/** Spawns the `git` child, mapping a synchronous spawn throw to a `StorageError`. */
const spawnGitChild = (
  spawn: Spawn,
  cwd: AbsolutePath,
  args: readonly string[]
): Result<ChildProcessWithoutNullStreams, StorageError> => {
  try {
    return Result.ok(
      spawn('git', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: String(cwd),
      })
    );
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to spawn git: ${stringifyError(cause)}`,
        cause,
      })
    );
  }
};

interface OutputCollector {
  /** Buffers a stdout chunk. Returns `true` the instant the cap trips, so the caller — which
   * owns the child process — can kill it; further chunks are dropped once truncated. */
  readonly appendStdout: (chunk: Buffer) => boolean;
  readonly appendStderr: (chunk: Buffer) => void;
  readonly isTruncated: () => boolean;
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
}

/**
 * Buffers stdout/stderr up to `maxOutputBytes`. Mirrors shell-script-runner's byte-cap
 * bookkeeping so a huge AI-generated diff can't OOM the heap.
 */
const createOutputCollector = (maxOutputBytes: number): OutputCollector => {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;

  const appendStdout = (chunk: Buffer): boolean => {
    if (truncated) return false;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxOutputBytes) {
      truncated = true;
      return true;
    }
    stdoutChunks.push(chunk);
    return false;
  };

  // stderr is tiny in practice; cap it too for consistency. No marker is emitted for stderr.
  const appendStderr = (chunk: Buffer): void => {
    if (stderrBytes > maxOutputBytes) return;
    stderrBytes += chunk.length;
    if (stderrBytes > maxOutputBytes) return;
    stderrChunks.push(chunk);
  };

  return {
    appendStdout,
    appendStderr,
    isTruncated: () => truncated,
    stdoutText: () => Buffer.concat(stdoutChunks).toString('utf8'),
    stderrText: () => Buffer.concat(stderrChunks).toString('utf8'),
  };
};

/**
 * Translates a `close` event into the final `Result`. Timeout takes precedence (cap-kills are
 * tracked separately via `collector.isTruncated()` so they never masquerade as a timeout).
 * Materializing stdout can throw `ERR_STRING_TOO_LONG` when output exceeds V8's max string
 * length (~512MiB — e.g. a `git diff HEAD` over enormous generated artifacts); this runs outside
 * any caller try/catch, so the throw is caught here and mapped to a `StorageError` instead of
 * killing the process.
 */
const buildCloseResult = (
  collector: OutputCollector,
  timedOut: boolean,
  code: number | null,
  timeoutMs: number,
  args: readonly string[],
  maxOutputBytes: number
): Result<GitRunResult, StorageError> => {
  if (timedOut) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git timed out after ${String(timeoutMs)}ms: git ${args.join(' ')}`,
      })
    );
  }
  try {
    const base = collector.stdoutText();
    const stdout = collector.isTruncated()
      ? `${base}\n[git output exceeded ${String(maxOutputBytes)} byte cap — truncated]`
      : base;
    return Result.ok({
      stdout,
      stderr: collector.stderrText(),
      exitCode: code ?? -1,
    });
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git output too large to materialize: git ${args.join(' ')} — ${stringifyError(cause)}`,
      })
    );
  }
};

const runGitOnce = (
  spawn: Spawn,
  cwd: AbsolutePath,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number
): Promise<Result<GitRunResult, StorageError>> =>
  new Promise((resolve) => {
    const spawnResult = spawnGitChild(spawn, cwd, args);
    if (!spawnResult.ok) {
      resolve(Result.error(spawnResult.error));
      return;
    }
    const child = spawnResult.value;

    const collector = createOutputCollector(maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const killChild = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
    };

    // Drop further chunks once the cap is hit and kill the child so git stops producing more
    // (mirrors shell-script-runner). The kill drives `close`, which the handler below reports
    // as cap-truncation rather than a timeout.
    child.stdout.on('data', (c: Buffer) => {
      if (collector.appendStdout(c)) killChild();
    });
    child.stderr.on('data', (c: Buffer) => collector.appendStderr(c));

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    const finish = (result: Result<GitRunResult, StorageError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (err) => {
      finish(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `git spawn error: ${err.message}`,
            cause: err,
          })
        )
      );
    });

    child.on('close', (code) => {
      finish(buildCloseResult(collector, timedOut, code, timeoutMs, args, maxOutputBytes));
    });
  });

const defaultSpawn: Spawn = (command, args, options) =>
  crossPlatformSpawn(command, args, { ...options, stdio: [...options.stdio] }) as ReturnType<Spawn>;

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
