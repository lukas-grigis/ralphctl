/**
 * `SessionRunner` — orchestrates a single provider invocation:
 *
 *  1. Build CLI args via the {@link ProviderAdapter}.
 *  2. Spawn the binary through {@link ProcessRunner}.
 *  3. Translate exit code + captured stderr into a typed `Result`:
 *     - rate-limit pattern in stderr at non-zero exit →
 *       {@link RateLimitError} with `subCode: 'spawn-exit'`
 *     - other non-zero exit → {@link StorageError} with `subCode: 'io'`
 *     - zero exit → parsed {@link SessionResult}
 *  4. Capture session id from JSON output, falling back to the
 *     adapter's optional `extractSessionId` side-channel.
 *
 * Interactive runs are deliberately *not* funnelled through the process
 * runner: they need `stdio: 'inherit'` so the user can drive the child
 * directly. The interactive path lives here for parity with the headless
 * path so the session adapter doesn't have to know about `child_process`.
 */
import { spawn } from 'node:child_process';

import { RateLimitError } from '@src/domain/errors/rate-limit-error.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SessionResult } from '@src/business/ports/ai-session-port.ts';
import type { ProviderAdapter } from '@src/integration/ai/providers/types.ts';
import type { ProcessRunner } from './process-runner.ts';

/** Hard cap on the prompt size piped to stdin (1 MB — beyond this the OS pipe buffer can't hold the spawn synchronously). */
const MAX_PROMPT_SIZE = 1_000_000;

export interface RunHeadlessOptions {
  readonly prompt: string;
  readonly cwd: AbsolutePath;
  readonly extraArgs?: readonly string[];
  readonly resumeSessionId?: string;
  readonly abortSignal?: AbortSignal;
  readonly env?: Record<string, string>;
}

export interface RunInteractiveOptions {
  readonly prompt: string;
  readonly cwd: AbsolutePath;
  readonly extraArgs?: readonly string[];
  readonly abortSignal?: AbortSignal;
  readonly env?: Record<string, string>;
}

export class SessionRunner {
  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly process: ProcessRunner
  ) {}

  async runHeadless(opts: RunHeadlessOptions): Promise<Result<SessionResult, RateLimitError | StorageError>> {
    if (opts.prompt.length > MAX_PROMPT_SIZE) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `prompt exceeds maximum size (${String(MAX_PROMPT_SIZE)} bytes)`,
        })
      );
    }

    let args = [...this.adapter.buildHeadlessArgs(opts.extraArgs ?? [])];
    if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
      try {
        args = [...args, ...this.adapter.buildResumeArgs(opts.resumeSessionId)];
      } catch (err) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: 'invalid resume session id',
            cause: err,
          })
        );
      }
    }

    const env = {
      ...this.adapter.getSpawnEnv(),
      ...(opts.env ?? {}),
    };

    const spawnResult = await this.process.run(this.adapter.binary, args, {
      cwd: opts.cwd,
      env,
      stdin: opts.prompt,
      abortSignal: opts.abortSignal,
    });

    if (!spawnResult.ok) {
      return spawnResult;
    }

    const { stdout, stderr, exitCode } = spawnResult.value;

    const parsed = this.adapter.parseJsonOutput(stdout);
    const sessionId =
      parsed.sessionId ?? (this.adapter.extractSessionId ? await this.adapter.extractSessionId(opts.cwd) : null);

    if (exitCode !== 0) {
      const rl = this.adapter.detectRateLimit(stderr);
      if (rl.rateLimited) {
        return Result.error(
          new RateLimitError({
            subCode: 'spawn-exit',
            retryAfterMs: rl.retryAfterMs ?? undefined,
            sessionId: sessionId ?? undefined,
            message: `${this.adapter.displayName} CLI rate-limited (exit ${String(exitCode)})`,
            hint: 'The provider is rate-limiting requests. The harness will retry automatically when the window clears.',
          })
        );
      }
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `${this.adapter.displayName} CLI exited with code ${String(exitCode)}`,
          cause: { exitCode, stderr },
        })
      );
    }

    return Result.ok({
      output: parsed.result,
      ...(sessionId !== null ? { sessionId } : {}),
      ...(parsed.model !== null ? { model: parsed.model } : {}),
      numTurns: parsed.numTurns,
    });
  }

  runInteractive(opts: RunInteractiveOptions): Promise<Result<void, RateLimitError | StorageError>> {
    const args = this.adapter.buildInteractiveArgs(opts.prompt, opts.extraArgs ?? []);
    const env = {
      ...process.env,
      ...this.adapter.getSpawnEnv(),
      ...(opts.env ?? {}),
    };

    return new Promise((resolve) => {
      // Already aborted? Reject before spawning.
      if (opts.abortSignal?.aborted) {
        resolve(
          Result.error(
            new StorageError({
              subCode: 'io',
              message: `aborted before spawn: ${this.adapter.binary}`,
            })
          )
        );
        return;
      }

      let settled = false;
      const settle = (outcome: Result<void, RateLimitError | StorageError>): void => {
        if (settled) return;
        settled = true;
        if (opts.abortSignal) {
          opts.abortSignal.removeEventListener('abort', abortListener);
        }
        resolve(outcome);
      };

      const child = spawn(this.adapter.binary, [...args], {
        cwd: opts.cwd,
        stdio: 'inherit',
        env,
      });

      const abortListener = (): void => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Best-effort.
        }
      };
      if (opts.abortSignal) {
        opts.abortSignal.addEventListener('abort', abortListener, { once: true });
      }

      child.on('error', (err: Error) => {
        settle(
          Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to spawn ${this.adapter.binary}: ${err.message}`,
              cause: err,
            })
          )
        );
      });

      child.on('close', (code) => {
        const exitCode = code ?? 0;
        if (exitCode === 0) {
          settle(Result.ok());
          return;
        }
        settle(
          Result.error(
            new StorageError({
              subCode: 'io',
              message: `${this.adapter.displayName} CLI exited with code ${String(exitCode)}`,
              cause: { exitCode },
            })
          )
        );
      });
    });
  }
}
