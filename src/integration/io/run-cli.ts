import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { messageOf } from '@src/domain/value/error/error-message.ts';
import type { Spawn } from '@src/integration/io/spawn.ts';
import { killWithEscalation } from '@src/integration/io/kill-with-escalation.ts';
import { onChildDone } from '@src/integration/io/child-exit.ts';

/**
 * Output of a single CLI invocation. `exitCode` is `null` only when the child died by a signal
 * without a numeric code.
 *
 * Unlike the doctor probes' {@link runCommand}, this pipes stdin (`gh … --body-file -`) and pins a
 * working directory (`gh pr create` must run inside the repo). The SCM adapters funnel through here.
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
  /** Hard wall-clock timeout, cleared once the child exits. */
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
        // Name the cause: a sync throw is as likely an oversized argv (E2BIG) as a missing binary.
        message: `${command} failed to spawn: ${messageOf(cause)}`,
        cause,
      })
    );
  }
};

/**
 * Buffer output and wire the terminal handlers through `settleOnce`. Done is `close`, or a short
 * drain after `exit` when a process the CLI left behind still holds its pipes, so a call that
 * finished is never reported as a timeout.
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
  child.once('exit', () => {
    clearTimeout(timer);
  });
  onChildDone(child, (code) => {
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

/** Write (or close) stdin. A write failure is treated the same as a spawn error — the done handler still resolves. */
const writeStdinBody = (child: ChildProcessWithoutNullStreams, stdin: string | undefined): void => {
  try {
    // EPIPE from a child that exited early arrives as an async 'error' event; the exit code reports it.
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  } catch {
    // ignore — the done handler will resolve regardless
  }
};

/**
 * Run a CLI through the injected {@link Spawn}, buffering output until the child is done or the
 * timeout trips. Every failure to run (missing binary, spawn error, timeout) is a
 * `StorageError(subCode: 'io')`. A non-zero exit is NOT an error here — callers that classify
 * stderr ("not found", an unknown flag) need the raw result; the rest use {@link requireCleanExit}.
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

/** A non-zero exit as the uniform `<label> failed: <stderr>` `StorageError`. */
export const requireCleanExit = (
  result: Result<CliRunResult, StorageError>,
  label: string,
  context?: string
): Result<CliRunResult, StorageError> => {
  if (!result.ok || result.value.exitCode === 0) return result;
  const detail = result.value.stderr.trim() || 'unknown error';
  return Result.error(
    new StorageError({
      subCode: 'io',
      message: `${label} failed: ${detail}${context !== undefined ? ` (${context})` : ''}`,
    })
  );
};

/** Parse a CLI's JSON stdout; malformed output is a `parse` `StorageError` naming `label`. */
export const parseCliJson = <T>(stdout: string, label: string): Result<T, StorageError> => {
  try {
    // Callers type every field optional and default it at the use site. The outer cast is
    // typescript-result's generic Ok<T> not widening to Result<T, E> on its own.
    return Result.ok(JSON.parse(stdout) as T) as Result<T, StorageError>;
  } catch (cause) {
    return Result.error(new StorageError({ subCode: 'parse', message: `failed to parse ${label} response`, cause }));
  }
};
