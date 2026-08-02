import type { ChildProcessWithoutNullStreams } from 'node:child_process';
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

/** Spawn the child, translating a thrown spawn error into the same `StorageError` shape every other failure uses. */
const trySpawnChild = (
  spawn: Spawn,
  command: string,
  args: readonly string[],
  opts: CliRunOptions
): Result<ChildProcessWithoutNullStreams, StorageError> => {
  try {
    return Result.ok(
      spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      })
    );
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `${command} not installed or failed to spawn`,
        cause,
      })
    );
  }
};

/**
 * Wire stdout/stderr buffering plus the `error` / `close` terminal handlers. Both terminal
 * handlers route through `settleOnce`, which the caller has already guarded to fire only once
 * (a `close` racing an already-timed-out `error`, or vice-versa, must not resolve twice).
 */
const wireChildOutput = (
  child: ChildProcessWithoutNullStreams,
  command: string,
  stdout: Buffer[],
  stderr: Buffer[],
  timer: NodeJS.Timeout,
  settleOnce: (result: Result<CliRunResult, StorageError>) => void
): void => {
  child.stdout.on('data', (c: Buffer) => stdout.push(c));
  child.stderr.on('data', (c: Buffer) => stderr.push(c));
  child.on('error', (err) => {
    clearTimeout(timer);
    settleOnce(
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
    clearTimeout(timer);
    settleOnce(
      Result.ok({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code,
      })
    );
  });
};

/** Write (or close) stdin. A write failure is treated the same as a spawn error — the `close` handler still resolves. */
const writeStdinBody = (child: ChildProcessWithoutNullStreams, stdin: string | undefined): void => {
  try {
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  } catch {
    // ignore — the close handler will resolve regardless
  }
};

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
    const spawned = trySpawnChild(spawn, command, args, opts);
    if (!spawned.ok) {
      resolve(Result.error(spawned.error));
      return;
    }
    const child = spawned.value;

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settleOnce = (result: Result<CliRunResult, StorageError>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      // SIGTERM → grace → SIGKILL: a wedged child that ignores SIGTERM is still reaped, so it
      // can't linger holding locks after we settle. Resolution is not delayed.
      killWithEscalation(child);
      settleOnce(
        Result.error(
          new StorageError({
            subCode: 'io',
            message: `${command} timed out after ${String(opts.timeoutMs)}ms`,
          })
        )
      );
    }, opts.timeoutMs);

    wireChildOutput(child, command, stdout, stderr, timer, settleOnce);
    writeStdinBody(child, opts.stdin);
  });
