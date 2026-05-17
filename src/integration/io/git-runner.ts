import { spawn as nodeSpawn } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';

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
}

export const createGitRunner = (deps: GitRunnerDeps = {}): GitRunner => {
  const spawn = deps.spawn ?? defaultSpawn;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

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
      let timedOut = false;
      let settled = false;

      child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
      child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead
        }
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
        finish(
          Result.ok({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode: code ?? -1,
          })
        );
      });
    });

  return { run };
};

const defaultSpawn: Spawn = (command, args, options) =>
  nodeSpawn(command, [...args], { ...options, stdio: [...options.stdio] }) as ReturnType<Spawn>;

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
