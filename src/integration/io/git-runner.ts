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
    new Promise((resolve) => {
      const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
      let child;
      try {
        child = spawn('git', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: String(cwd),
        });
      } catch (cause) {
        resolve(
          Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to spawn git: ${stringifyError(cause)}`,
              cause,
            })
          )
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      // Cap-truncation is tracked separately from `timedOut`: the SIGTERM we issue for the cap
      // also fires the child's `close`, and that close must surface ok+marker, NOT the timeout
      // StorageError. A shared flag would let cap-kills masquerade as timeouts.
      let truncated = false;
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
      const appendStdout = (chunk: Buffer): void => {
        if (truncated) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          truncated = true;
          killChild();
          return;
        }
        stdoutChunks.push(chunk);
      };
      // stderr is tiny in practice; cap it too for consistency. No marker is emitted for stderr.
      const appendStderr = (chunk: Buffer): void => {
        if (stderrBytes > maxOutputBytes) return;
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) return;
        stderrChunks.push(chunk);
      };

      child.stdout.on('data', (c: Buffer) => appendStdout(c));
      child.stderr.on('data', (c: Buffer) => appendStderr(c));

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
        if (timedOut) {
          finish(
            Result.error(
              new StorageError({
                subCode: 'io',
                message: `git timed out after ${String(timeoutMs)}ms: git ${args.join(' ')}`,
              })
            )
          );
          return;
        }
        // Materializing stdout can throw ERR_STRING_TOO_LONG when output exceeds V8's max string
        // length (~512MiB — e.g. a `git diff HEAD` over enormous generated artifacts). This close
        // handler runs outside any caller try/catch, so an uncaught throw here would kill the
        // whole process instead of surfacing through the Result envelope. Catch and map to
        // StorageError — consumers like the work-product fingerprint degrade gracefully.
        try {
          const base = Buffer.concat(stdoutChunks).toString('utf8');
          const stdout = truncated
            ? `${base}\n[git output exceeded ${String(maxOutputBytes)} byte cap — truncated]`
            : base;
          finish(
            Result.ok({
              stdout,
              stderr: Buffer.concat(stderrChunks).toString('utf8'),
              exitCode: code ?? -1,
            })
          );
        } catch (cause) {
          finish(
            Result.error(
              new StorageError({
                subCode: 'io',
                message: `git output too large to materialize: git ${args.join(' ')} — ${stringifyError(cause)}`,
              })
            )
          );
        }
      });
    });

  return { run };
};

const defaultSpawn: Spawn = (command, args, options) =>
  crossPlatformSpawn(command, args, { ...options, stdio: [...options.stdio] }) as ReturnType<Spawn>;

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
