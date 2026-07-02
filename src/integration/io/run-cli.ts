import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { killWithEscalation } from '@src/integration/io/kill-with-escalation.ts';

/**
 * Output of a single CLI invocation. `exitCode` is `null` only when the close event never
 * delivered a numeric code (rare — typically the timer path resolves first with an error
 * before the close handler fires).
 *
 * Sibling utility to {@link runCommand} (`run-command.ts`): that one is for one-shot probes
 * via `execFile` with no stdin and no cwd; this one wraps `spawn` so we can pipe stdin
 * (`gh issue edit --body-file -`) and pin a working directory (`gh pr create` must run inside
 * the repo it's creating the PR from). All three SCM adapters — `issue-fetcher`,
 * `issue-pusher`, `pull-request-creator` — funnel through here.
 */
export interface CliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface CliRunOptions {
  /** Body piped to the child's stdin. Omit for argv-only invocations. */
  readonly stdin?: string;
  /** Working directory for the child. Required by `gh pr create`; left undefined for plain queries. */
  readonly cwd?: string;
  /**
   * Hard wall-clock timeout. SCM read paths use 30s; pull-request creation uses 60s because
   * `gh pr create` blocks on auth + network round-trips. The timer is cleared on close.
   */
  readonly timeoutMs: number;
}

/**
 * Run a CLI through the injected {@link Spawn}, buffering stdout/stderr until the child closes
 * or the timeout trips. Every failure mode (missing binary, spawn error, timeout) surfaces as a
 * `StorageError` with `subCode: 'io'` so callers handle one error shape.
 *
 * Non-zero exit codes do NOT produce a `Result.error` — callers inspect `exitCode` themselves
 * because each CLI has its own "not found" / "auth required" / "network" stderr signatures
 * that the SCM adapters classify upstream.
 */
export const runCli = (
  spawn: Spawn,
  command: string,
  args: readonly string[],
  opts: CliRunOptions
): Promise<Result<CliRunResult, StorageError>> =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    } catch (cause) {
      resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `${command} not installed or failed to spawn`,
            cause,
          })
        )
      );
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // SIGTERM → grace → SIGKILL: a wedged child that ignores SIGTERM is still reaped, so it
      // can't linger holding locks after we settle. Resolution is not delayed.
      killWithEscalation(child);
      resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `${command} timed out after ${String(opts.timeoutMs)}ms`,
          })
        )
      );
    }, opts.timeoutMs);

    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `${command} spawn error: ${err.message}`,
            cause: err,
          })
        )
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        Result.ok({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code,
        })
      );
    });

    if (opts.stdin !== undefined) {
      try {
        child.stdin.end(opts.stdin);
      } catch {
        // Treat a write failure the same as a spawn error; the close handler will resolve.
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
    }
  });
