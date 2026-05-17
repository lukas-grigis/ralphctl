import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';

/**
 * Advisory cooperative file lock. The holder writes a JSON file at the lock path containing
 * its PID and an ISO timestamp; competitors see `EEXIST` and either wait or take over if the
 * holder is stale. Used to serialize:
 *   - `progress.md` writes (per-sprint)
 *   - `feedback.md` writes (per-sprint)
 *   - whole-flow runs against a working tree (per-repository)
 *
 * Stale-takeover criteria:
 *   - timestamp older than `staleAfterMs`, OR
 *   - PID no longer running (signal 0 liveness check on the same machine)
 *
 * All failures map to `StorageError({ subCode: 'lock' })`. The release path runs in a
 * `finally` so the lock is always cleared, even if the wrapped function throws.
 */

interface LockInfo {
  readonly pid: number;
  readonly timestamp: string;
}

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_RETRIES = 100;
const DEFAULT_STALE_AFTER_MS = 30_000;
const STALE_LOWER_BOUND_MS = 1;
const STALE_UPPER_BOUND_MS = 3_600_000;

export interface FileLockerOptions {
  /** How long (ms) before a lock file is considered stale. Clamped to 1..3_600_000. Default 30_000. */
  readonly staleAfterMs?: number;
  /** Retry delay (ms) when contending for an active lock. Default 50. */
  readonly retryDelayMs?: number;
  /** Maximum retry attempts before giving up. Default 100 (~5s at 50ms). */
  readonly maxRetries?: number;
  /** Test seam: defaults to `Date.now`. */
  readonly now?: () => number;
  /** Test seam: defaults to `process.pid`. */
  readonly pid?: () => number;
  /** Test seam: defaults to a `process.kill(pid, 0)` liveness probe. */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Test seam: defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Optional callback for non-fatal lock errors — currently only "failed to remove our own
   * lock file on release". Fires for genuine errors (EACCES, EROFS, …), NOT for the expected
   * stale-takeover case (ENOENT, another process unlinked it before us). Use to surface stale
   * `.lock` files that would otherwise block subsequent runs invisibly. Default: no-op.
   */
  readonly onWarning?: (warning: {
    readonly kind: 'release-unlink-failed';
    readonly path: string;
    readonly cause: unknown;
  }) => void;
}

export interface FileLocker {
  /**
   * Acquire the lock at `lockPath`, run `fn`, then release. The release runs in a `finally`
   * so a thrown `fn` still clears the lock. Returns the function's result wrapped in
   * `Result.ok`, or a `StorageError` if the lock could not be acquired.
   */
  withLock<T>(lockPath: AbsolutePath, fn: () => Promise<T>): Promise<Result<T, StorageError>>;
}

export const createFileLocker = (opts: FileLockerOptions = {}): FileLocker => {
  const staleAfterMs = clampStaleAfter(opts.staleAfterMs);
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? ((): number => process.pid);
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const sleep = opts.sleep ?? defaultSleep;

  const acquire = async (lockPath: string): Promise<Result<void, StorageError>> => {
    const info: LockInfo = { pid: pid(), timestamp: new Date(now()).toISOString() };
    let retries = 0;
    while (retries < maxRetries) {
      try {
        await fs.mkdir(dirname(lockPath), { recursive: true });
        await fs.writeFile(lockPath, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
        return Result.ok(undefined);
      } catch (cause) {
        if (errnoCode(cause) !== 'EEXIST') {
          return Result.error(
            new StorageError({
              subCode: 'lock',
              message: `failed to acquire lock: ${stringifyError(cause)}`,
              path: lockPath,
              cause,
            })
          );
        }
        if (await isStale(lockPath, staleAfterMs, now, isPidAlive)) {
          // Best-effort takeover: another process may grab it first; either way we loop.
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
        retries++;
        await sleep(retryDelayMs);
      }
    }
    return Result.error(
      new StorageError({
        subCode: 'lock',
        message: `failed to acquire lock after ${String(maxRetries)} retries`,
        path: lockPath,
        hint: 'another ralphctl process is using this resource — wait, or remove the .lock file if stale',
      })
    );
  };

  const withLock = async <T>(lockPath: AbsolutePath, fn: () => Promise<T>): Promise<Result<T, StorageError>> => {
    const path = String(lockPath);
    const acquired = await acquire(path);
    if (!acquired.ok) return Result.error(acquired.error);
    try {
      const value = await fn();
      return Result.ok(value) as Result<T, StorageError>;
    } finally {
      try {
        await fs.unlink(path);
      } catch (cause) {
        // ENOENT is the expected stale-takeover case (another process unlinked our lock). Any
        // other errno — EACCES, EROFS, EBUSY — means we left a `.lock` file behind that will
        // block the next run until the operator clears it. Surface via the optional warning
        // hook; we don't fail the whole call because `fn` already produced a value.
        if (!isNodeErrnoCode(cause, 'ENOENT')) {
          opts.onWarning?.({ kind: 'release-unlink-failed', path, cause });
        }
      }
    }
  };

  return { withLock };
};

const isStale = async (
  lockPath: string,
  staleAfterMs: number,
  now: () => number,
  isPidAlive: (pid: number) => boolean
): Promise<boolean> => {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch {
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
  if (now() - ts > staleAfterMs) return true;
  return !isPidAlive(parsed.pid);
};

const clampStaleAfter = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_STALE_AFTER_MS;
  return Math.min(STALE_UPPER_BOUND_MS, Math.max(STALE_LOWER_BOUND_MS, Math.floor(value)));
};

const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errnoCode = (cause: unknown): string | undefined => {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
};

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
