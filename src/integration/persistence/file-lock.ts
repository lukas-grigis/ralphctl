import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Result } from 'typescript-result';
import { LockError } from '@src/domain/errors.ts';

/**
 * Simple file-based lock for preventing concurrent access.
 * Uses a .lock file with process info.
 */

export interface LockInfo {
  pid: number;
  timestamp: number;
}

/** How long (ms) before a lock file is considered stale. Override with RALPHCTL_LOCK_TIMEOUT_MS (1 to 3600000). */
const parsed = parseInt(process.env['RALPHCTL_LOCK_TIMEOUT_MS'] ?? '', 10);
export const LOCK_TIMEOUT_MS = parsed > 0 && parsed <= 3_600_000 ? parsed : 30_000;

/** Delay (ms) between retry attempts when a lock is held by another process. */
export const RETRY_DELAY_MS = 50;

/** Maximum number of retries before giving up (~5 seconds at default RETRY_DELAY_MS). */
export const MAX_RETRIES = 100;

function getLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a lock file is stale (old process that may have crashed).
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const content = await readFile(lockPath, 'utf-8');
    const info: LockInfo = JSON.parse(content) as LockInfo;

    // Check if lock is old enough to be considered stale
    const age = Date.now() - info.timestamp;
    if (age > LOCK_TIMEOUT_MS) {
      return true;
    }

    // Check if the process is still running (only works for same-machine processes)
    try {
      process.kill(info.pid, 0); // signal 0 tests existence
      return false; // Process exists
    } catch {
      return true; // Process doesn't exist
    }
  } catch {
    // Lock file is corrupted or unreadable, consider it stale
    return true;
  }
}

/**
 * Acquire a lock on a file path.
 * Returns a Result containing a release function that must be called when done.
 */
export async function acquireLock(filePath: string) {
  const lockPath = getLockPath(filePath);
  const lockInfo: LockInfo = {
    pid: process.pid,
    timestamp: Date.now(),
  };

  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      // Ensure directory exists
      await mkdir(dirname(lockPath), { recursive: true });

      // Try to create lock file exclusively
      await writeFile(lockPath, JSON.stringify(lockInfo), { flag: 'wx', mode: 0o600 });

      // Success - return release function
      return Result.ok(async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Ignore errors during cleanup
        }
      });
    } catch (err) {
      // File exists - check if stale
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
        if (await isLockStale(lockPath)) {
          // Remove stale lock and retry immediately
          try {
            await unlink(lockPath);
          } catch {
            // Ignore - another process may have grabbed it
          }
          continue;
        }

        // Lock is active, wait and retry
        retries++;
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      return Result.error(
        new LockError(
          `Failed to acquire lock: ${err instanceof Error ? err.message : String(err)}`,
          lockPath,
          err instanceof Error ? err : undefined
        )
      );
    }
  }

  return Result.error(new LockError(`Failed to acquire lock after ${String(MAX_RETRIES)} retries`, lockPath));
}

/**
 * Execute a function with a file lock.
 * Automatically acquires and releases the lock.
 * Returns the result of the callback, or a LockError if the lock cannot be acquired.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>) {
  const lockResult = await acquireLock(filePath);
  if (!lockResult.ok) {
    return lockResult;
  }

  const release = lockResult.value;
  try {
    const value = await fn();
    return Result.ok(value);
  } finally {
    await release();
  }
}
