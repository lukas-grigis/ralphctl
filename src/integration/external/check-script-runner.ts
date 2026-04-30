/**
 * `CheckScriptRunner` — runs project-configured check scripts and lifecycle
 * hooks. Same shape and semantics as the legacy `runLifecycleHook`.
 *
 * Scripts are user-configured during `project add` / `project repo add`;
 * they are NOT arbitrary AI-generated commands. We still run them through
 * a shell so user-friendly forms like `pnpm install && pnpm typecheck`
 * work without manual splitting.
 *
 * Output handling:
 *  - stdout + stderr are captured into a single combined buffer (the
 *    consumer renders them as one stream and order matters).
 *  - There's a 50 MB hard cap on the buffered output. Real check scripts
 *    on big monorepos can legitimately emit several MB; the cap exists to
 *    prevent a runaway loop from OOM'ing the harness. When the cap is hit
 *    we kill the child and append a truncation marker.
 *  - Default timeout is 5 minutes (matches `RALPHCTL_SETUP_TIMEOUT_MS`),
 *    overridable per-call (per-repo `checkTimeout`).
 *
 * Result semantics:
 *  - `Result.ok({ passed: true | false, output })` — script ran to
 *    completion. `passed` is `exitCode === 0`. A non-zero exit is *not*
 *    a system failure — the gate failed cleanly and the caller (e.g. the
 *    post-task gate) decides what to do.
 *  - `Result.error(StorageError)` — only for system-level failures the
 *    caller can't be expected to recover from inside the harness (spawn
 *    fails because the shell binary is missing, etc.). Timeouts and
 *    output-cap kills surface as `passed: false` with a marker, not as
 *    errors — that's the legacy behaviour callers depend on.
 */
import { spawn } from 'node:child_process';

import { StorageError } from '../../domain/errors/storage-error.ts';
import { Result } from '../../domain/result.ts';
import type { AbsolutePath } from '../../domain/values/absolute-path.ts';

export type CheckScriptPhase = 'sprint-start' | 'post-task' | 'feedback';

export interface CheckScriptResult {
  readonly passed: boolean;
  readonly output: string;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export class CheckScriptRunner {
  /** Default timeout in milliseconds applied when the per-call argument is omitted. */
  readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  run(
    cwd: AbsolutePath,
    script: string,
    phase: CheckScriptPhase,
    timeoutMs?: number
  ): Promise<Result<CheckScriptResult, StorageError>> {
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(script, {
          cwd,
          shell: true,
          // detached: process group leader so SIGTERM to -pid reaches
          // descendants spawned by `sh -c`. Windows has no process groups.
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, RALPHCTL_LIFECYCLE_EVENT: phase },
        });
      } catch (err) {
        resolve(
          Result.error(
            new StorageError({
              subCode: 'io',
              message: `failed to spawn check script: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            })
          )
        );
        return;
      }

      const killTree = (): void => {
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          try {
            process.kill(-child.pid, 'SIGTERM');
            return;
          } catch {
            // group already gone — fall through.
          }
        }
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead.
        }
      };

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let timedOut = false;
      let capExceeded = false;
      let settled = false;

      const appendChunk = (chunk: Buffer): void => {
        if (capExceeded) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          capExceeded = true;
          killTree();
          return;
        }
        chunks.push(chunk);
      };

      child.stdout.on('data', (c: Buffer) => {
        appendChunk(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        appendChunk(c);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, effectiveTimeout);

      const finish = (passed: boolean, suffix?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const base = Buffer.concat(chunks).toString('utf-8').trim();
        const output = suffix ? (base ? `${base}\n${suffix}` : suffix) : base;
        resolve(Result.ok({ passed, output }));
      };

      child.on('error', (err) => {
        // Spawn-time error after the spawn() call returned (e.g. shell
        // binary disappeared). Surface as passed: false with a marker —
        // callers treat this the same way they'd treat a script that
        // exited 127. Not a Result.error: the harness can keep going.
        finish(false, `[spawn error: ${err.message}]`);
      });

      child.on('close', (code) => {
        if (timedOut) {
          finish(false, `[timeout exceeded after ${String(effectiveTimeout)}ms]`);
          return;
        }
        if (capExceeded) {
          finish(false, `[output exceeded ${String(MAX_OUTPUT_BYTES)} byte cap — truncated]`);
          return;
        }
        finish(code === 0);
      });
    });
  }
}
