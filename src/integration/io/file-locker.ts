import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import properLockfile from 'proper-lockfile';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Advisory cooperative file lock, backed by `proper-lockfile`. The holder creates a lock
 * directory (atomic `mkdir`, so it works on NFS where `O_EXCL` open is unreliable) and a
 * background timer keeps its mtime fresh — a **heartbeat**. Competitors see the directory and
 * either wait (retry) or take over only once the heartbeat has gone stale. Used to serialize:
 *   - `tasks.json` writes (per-sprint)
 *   - whole-flow runs against a working tree (per-repository / per-sprint)
 *
 * **Why a heartbeat (and not an age-on-acquire timestamp).** The implement flow holds one lock
 * across the WHOLE run (prologue → waves → epilogue), which can take many minutes. A lock judged
 * stale purely by "age since acquisition" would become takeover-eligible mid-run while its
 * holder is alive and folding — letting a second process race the same sprint branch. The
 * heartbeat keeps a LIVE holder's lock perpetually fresh, so it is never falsely stolen no
 * matter how long the run lasts; a CRASHED holder stops heartbeating and is reclaimed once the
 * mtime passes `staleAfterMs`. `staleAfterMs` therefore bounds crash-reclaim latency only.
 *
 * All failures map to `StorageError({ subCode: 'lock' })`. The release runs in a `finally` so the
 * lock is always cleared, even when the wrapped function throws.
 *
 * Nothing reads the on-disk lock format — its shape is wholly internal to this module, so the
 * backing library owns it. (Pre-`proper-lockfile` runs wrote a JSON *file* at the lock path;
 * this writes a *directory*. A leftover old-format file from an in-flight upgrade self-heals via
 * the stale-reclaim path once `staleAfterMs` elapses.)
 */

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_RETRIES = 100;
const DEFAULT_STALE_AFTER_MS = 30_000;
// `proper-lockfile` does not enforce a floor, but a too-small `stale` would let a lock be judged
// stale between heartbeats. Keep a sane floor and refresh well inside the window (see below).
const STALE_LOWER_BOUND_MS = 2_000;
const STALE_UPPER_BOUND_MS = 3_600_000;
const MIN_HEARTBEAT_MS = 1_000;

export interface FileLockerOptions {
  /** How long (ms) before a lock is considered stale — i.e. crash-reclaim latency. Clamped 2_000..3_600_000. Default 30_000. */
  readonly staleAfterMs?: number;
  /** Retry delay (ms) when contending for an actively-held lock. Default 50. */
  readonly retryDelayMs?: number;
  /** Maximum retry attempts before giving up. Default 100 (~5s at 50ms). */
  readonly maxRetries?: number;
  /**
   * Optional callback for non-fatal lock anomalies:
   *   - `'release-unlink-failed'` — the lock could not be removed on release (e.g. EACCES, EROFS),
   *     so a stale lock directory may linger and block the next run until cleared.
   *   - `'lock-compromised'` — a HELD lock was lost mid-run (heartbeat could not refresh in time,
   *     or the lock directory was removed/taken over). Mutual exclusion may no longer hold; the
   *     in-flight function is NOT aborted here — surfaced loudly for the operator. Default: no-op.
   */
  readonly onWarning?: (
    warning:
      | { readonly kind: 'release-unlink-failed'; readonly path: string; readonly cause: unknown }
      | { readonly kind: 'lock-compromised'; readonly path: string; readonly cause: unknown }
  ) => void;
}

export interface FileLocker {
  /**
   * Acquire the lock at `lockPath`, run `fn`, then release. The release runs in a `finally`
   * so a thrown `fn` still clears the lock. Returns the function's result wrapped in
   * `Result.ok`, or a `StorageError` if the lock could not be acquired.
   *
   * `fn` receives an `AbortSignal` that aborts if the held lock is **compromised** mid-run (lost
   * to a takeover / a heartbeat the library could not refresh in time). Long-running holders
   * should thread it into their work so a compromised lock tears the run down rather than
   * continuing to mutate a resource another process may now own. Callers that don't need it may
   * ignore the parameter.
   */
  withLock<T>(lockPath: AbsolutePath, fn: (signal: AbortSignal) => Promise<T>): Promise<Result<T, StorageError>>;
}

export const createFileLocker = (opts: FileLockerOptions = {}): FileLocker => {
  const stale = clampStaleAfter(opts.staleAfterMs);
  // Refresh ~3× per stale window, floored at 1s and capped at `proper-lockfile`'s `stale/2` max,
  // so a live holder's mtime is renewed comfortably before any competitor could judge it stale.
  const heartbeatMs = Math.min(Math.floor(stale / 2), Math.max(MIN_HEARTBEAT_MS, Math.floor(stale / 3)));
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  const withLock = async <T>(
    lockPath: AbsolutePath,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<Result<T, StorageError>> => {
    const path = String(lockPath);
    // Aborts if the held lock is compromised — handed to `fn` so a long-running holder can tear
    // its work down instead of mutating a resource a competitor may have taken over.
    const compromised = new AbortController();
    let release: () => Promise<void>;
    try {
      // `proper-lockfile` needs the parent directory to exist before it can `mkdir` the lock dir.
      await fs.mkdir(dirname(path), { recursive: true });
      release = await properLockfile.lock(path, {
        // The lock paths (`repo-<hash>.lock`, `tasks.json.lock`) are not real files — lock them
        // lexically (`realpath: false`) and pin the on-disk lock directory to the path verbatim
        // (`lockfilePath: path`) so it is not suffixed into `<path>.lock`.
        realpath: false,
        lockfilePath: path,
        stale,
        update: heartbeatMs,
        // Constant-backoff retry mirrors the previous `maxRetries × retryDelayMs` (~5s) budget.
        retries: { retries: maxRetries, factor: 1, minTimeout: retryDelayMs, maxTimeout: retryDelayMs },
        // The library default for `onCompromised` THROWS (which would crash the process). Abort the
        // in-flight `fn` first (a compromised lock may now be held elsewhere), then surface a warning.
        onCompromised: (cause) => {
          if (!compromised.signal.aborted) compromised.abort(cause);
          opts.onWarning?.({ kind: 'lock-compromised', path, cause });
        },
      });
    } catch (cause) {
      return Result.error(
        new StorageError({
          subCode: 'lock',
          message: acquireErrorMessage(cause, maxRetries),
          path,
          cause,
          hint: 'another ralphctl process is using this resource — wait, or remove the .lock file if stale',
        })
      );
    }
    try {
      const value = await fn(compromised.signal);
      return Result.ok(value) as Result<T, StorageError>;
    } finally {
      try {
        await release();
      } catch (cause) {
        // `ERELEASED` (already released) and `ENOTACQUIRED` (the lock was compromised / taken over,
        // so it is no longer in our registry) are expected and benign. Any other errno — EACCES,
        // EROFS — means a lock directory was left behind that will block the next run; surface it.
        // We never fail the whole call, because `fn` already produced a value.
        if (!isBenignReleaseError(cause)) {
          opts.onWarning?.({ kind: 'release-unlink-failed', path, cause });
        }
      }
    }
  };

  return { withLock };
};

const clampStaleAfter = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_STALE_AFTER_MS;
  return Math.min(STALE_UPPER_BOUND_MS, Math.max(STALE_LOWER_BOUND_MS, Math.floor(value)));
};

/** `ELOCKED` = contention exhausted the retry budget; anything else is an unexpected acquire fault. */
const acquireErrorMessage = (cause: unknown, maxRetries: number): string =>
  errnoCode(cause) === 'ELOCKED'
    ? `failed to acquire lock after ${String(maxRetries)} retries`
    : `failed to acquire lock: ${stringifyError(cause)}`;

const BENIGN_RELEASE_CODES = new Set(['ERELEASED', 'ENOTACQUIRED']);
const isBenignReleaseError = (cause: unknown): boolean => BENIGN_RELEASE_CODES.has(errnoCode(cause) ?? '');

const errnoCode = (cause: unknown): string | undefined => {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
};

const stringifyError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
