/**
 * Async wrapper around `node:child_process.spawn` with abort support.
 *
 * The session runner uses this to launch the provider binary, capture
 * stdout/stderr fully, and translate process-level failures into typed
 * `Result`s. Streaming output is deliberately not supported — provider
 * runs are bounded short, and the simpler shape keeps the call sites
 * readable.
 *
 * On abort the runner sends `SIGTERM` to the child and gives it a 3-second
 * grace period before escalating to `SIGKILL`. The same machinery the
 * `ProcessManager` used, just scoped per-spawn instead of process-wide.
 */
import { spawn } from 'node:child_process';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';

/** Default grace period between SIGTERM and SIGKILL on abort. */
const ABORT_GRACE_MS = 3000;

/** Hard cap on captured stdout, in bytes — bigger output is a runaway session and we'd rather truncate than OOM. */
const MAX_STDOUT_SIZE = 10_000_000;

export interface ProcessRunOptions {
  readonly cwd: AbsolutePath;
  readonly env?: Record<string, string>;
  /** Optional stdin payload written before the stream is closed. */
  readonly stdin?: string;
  readonly abortSignal?: AbortSignal;
}

export interface ProcessRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Behaviour seam for the session runner so tests can substitute a fake
 * implementation without touching the real `child_process` module.
 */
export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): Promise<Result<ProcessRunResult, StorageError>>;
}

export interface NodeProcessRunnerOptions {
  /** Override the SIGTERM→SIGKILL grace window (used by tests). */
  readonly abortGraceMs?: number;
}

export class NodeProcessRunner implements ProcessRunner {
  private readonly abortGraceMs: number;

  constructor(opts: NodeProcessRunnerOptions = {}) {
    this.abortGraceMs = opts.abortGraceMs ?? ABORT_GRACE_MS;
  }

  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): Promise<Result<ProcessRunResult, StorageError>> {
    return new Promise((resolve) => {
      // Caller already aborted before we even spawned — short-circuit.
      if (options.abortSignal?.aborted) {
        resolve(
          Result.error(
            new StorageError({
              subCode: 'io',
              message: `aborted before spawn: ${command}`,
            })
          )
        );
        return;
      }

      const env = {
        ...process.env,
        ...(options.env ?? {}),
      };

      const child = spawn(command, [...args], {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      let stdout = '';
      let stderr = '';
      let killTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const settle = (outcome: Result<ProcessRunResult, StorageError>): void => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (options.abortSignal) {
          options.abortSignal.removeEventListener('abort', abortListener);
        }
        resolve(outcome);
      };

      const abortListener = (): void => {
        // SIGTERM first — give the child a chance to exit cleanly.
        try {
          child.kill('SIGTERM');
        } catch {
          // Best-effort: child may already be dead (ESRCH) or unkillable.
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ditto.
          }
        }, this.abortGraceMs);
      };

      if (options.abortSignal) {
        options.abortSignal.addEventListener('abort', abortListener, {
          once: true,
        });
      }

      child.stdout.on('data', (data: Buffer) => {
        if (stdout.length < MAX_STDOUT_SIZE) {
          stdout += data.toString();
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (err: Error) => {
        settle(
          Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to spawn ${command}: ${err.message}`,
              cause: err,
            })
          )
        );
      });

      child.on('close', (code) => {
        const exitCode = code ?? 1;
        settle(Result.ok({ stdout, stderr, exitCode }));
      });

      // Write stdin payload (if any) and close the stream so the child
      // can finish reading. Errors here surface via the 'error' event
      // above — no need to listen separately.
      if (options.stdin !== undefined && options.stdin.length > 0) {
        try {
          child.stdin.write(options.stdin);
        } catch {
          // Pipe may have closed already if the child crashed early.
        }
      }
      try {
        child.stdin.end();
      } catch {
        // Same reasoning — pipe state is racy on early failure.
      }
    });
  }
}
