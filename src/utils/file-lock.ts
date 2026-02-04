import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Simple file-based lock for preventing concurrent access.
 * Uses a .lock file with process info.
 */

export class LockAcquisitionError extends Error {
  public readonly lockPath: string;

  constructor(message: string, lockPath: string) {
    super(message);
    this.name = 'LockAcquisitionError';
    this.lockPath = lockPath;
  }
}

export interface LockInfo {
  pid: number;
  timestamp: number;
}

const LOCK_TIMEOUT_MS = 30000; // 30 seconds
const RETRY_DELAY_MS = 50; // 50ms between retries
const MAX_RETRIES = 100; // ~5 seconds total

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
 * Returns a release function that must be called when done.
 */
export async function acquireLock(filePath: string): Promise<() => Promise<void>> {
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
      await writeFile(lockPath, JSON.stringify(lockInfo), { flag: 'wx' });

      // Success - return release function
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Ignore errors during cleanup
        }
      };
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

      throw err;
    }
  }

  throw new LockAcquisitionError(`Failed to acquire lock after ${String(MAX_RETRIES)} retries`, lockPath);
}

/**
 * Execute a function with a file lock.
 * Automatically acquires and releases the lock.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(filePath);
  try {
    return await fn();
  } finally {
    await release();
  }
}
