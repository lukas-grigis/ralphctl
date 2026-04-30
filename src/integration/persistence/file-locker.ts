import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { StorageError } from '../../domain/errors/storage-error.ts';
import { Result } from '../../domain/result.ts';
import type { AbsolutePath } from '../../domain/values/absolute-path.ts';

interface LockInfo {
  readonly pid: number;
  readonly timestamp: string;
}

const RETRY_DELAY_MS = 50;
/** ~5s of retries at the default delay before we give up. */
const MAX_RETRIES = 100;
const DEFAULT_STALE_AFTER_MS = 30_000;
const STALE_LOWER_BOUND_MS = 1;
const STALE_UPPER_BOUND_MS = 3_600_000;

export interface FileLockerOptions {
  /**
   * How long (ms) before a lock file is considered stale. Defaults to
   * `RALPHCTL_LOCK_TIMEOUT_MS` (clamped to 1..3_600_000) or 30_000.
   */
  readonly staleAfterMs?: number;
}

/**
 * Advisory file lock — uses a sibling `<target>.lock` file containing the
 * holder's PID + ISO timestamp. The lock is reentrant only at the granularity
 * of `withLock` (don't nest calls on the same target).
 *
 * Implementations:
 *  - `wx` exclusive create races for the lock.
 *  - On `EEXIST`, the holder is inspected: if its timestamp is older than
 *    `staleAfterMs` *or* the PID is no longer running, the lock is taken
 *    over. Otherwise we sleep and retry.
 *  - All errors map to `StorageError({ subCode: 'lock' })`.
 *  - The release path runs in a `finally` block — even if `fn` throws.
 */
export class FileLocker {
  private readonly staleAfterMs: number;

  constructor(opts: FileLockerOptions = {}) {
    this.staleAfterMs = clampStaleAfter(opts.staleAfterMs ?? envStaleAfter());
  }

  async withLock<T>(target: AbsolutePath, fn: () => Promise<T>): Promise<Result<T, StorageError>> {
    const lockPath = `${target}.lock`;
    const acquired = await this.acquire(lockPath);
    if (!acquired.ok) return Result.error(acquired.error);
    try {
      const value = await fn();
      return Result.ok(value) as Result<T, StorageError>;
    } finally {
      // Release on every path — including when `fn` threw. Adapters that
      // hand us a function expecting a Result-shaped contract should not
      // throw, but if they do, propagating the throw past the finally is
      // still the right move (programmer-error visibility).
      try {
        await unlink(lockPath);
      } catch {
        // The lock may have already been removed by stale-takeover from
        // another process. Releasing is best-effort.
      }
    }
  }

  private async acquire(lockPath: string): Promise<Result<void, StorageError>> {
    const info: LockInfo = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
    };

    let retries = 0;
    while (retries < MAX_RETRIES) {
      try {
        await mkdir(dirname(lockPath), { recursive: true });
        await writeFile(lockPath, JSON.stringify(info), {
          flag: 'wx',
          mode: 0o600,
        });
        return Result.ok();
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'EEXIST') {
          if (await this.isStale(lockPath)) {
            try {
              await unlink(lockPath);
            } catch {
              // Another process may have grabbed it first; loop again.
            }
            continue;
          }
          retries++;
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return Result.error(
          new StorageError({
            subCode: 'lock',
            message: `failed to acquire lock: ${stringifyError(err)}`,
            path: lockPath,
            cause: err,
          })
        );
      }
    }

    return Result.error(
      new StorageError({
        subCode: 'lock',
        message: `failed to acquire lock after ${String(MAX_RETRIES)} retries`,
        path: lockPath,
        hint: 'Another ralphctl process is using this file. Wait, or remove the .lock file if stale.',
      })
    );
  }

  private async isStale(lockPath: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(lockPath, 'utf-8');
    } catch {
      // Unreadable / vanished — treat as stale so the next loop tries to
      // claim it.
      return true;
    }

    let parsed: LockInfo;
    try {
      parsed = JSON.parse(raw) as LockInfo;
    } catch {
      return true;
    }

    const ts = Date.parse(parsed.timestamp);
    if (!Number.isFinite(ts)) return true;
    if (Date.now() - ts > this.staleAfterMs) return true;

    // Same-machine PID liveness check (signal 0 = existence test).
    try {
      process.kill(parsed.pid, 0);
      return false;
    } catch {
      return true;
    }
  }
}

function clampStaleAfter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_STALE_AFTER_MS;
  return Math.min(STALE_UPPER_BOUND_MS, Math.max(STALE_LOWER_BOUND_MS, Math.floor(value)));
}

function envStaleAfter(): number {
  const raw = process.env['RALPHCTL_LOCK_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_STALE_AFTER_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STALE_AFTER_MS;
  return parsed;
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
