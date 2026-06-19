import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

/** Prefix every backup directory name shares — used to exclude prior backups from a fresh copy. */
export const BACKUP_DIR_PREFIX = 'data.backup-';

/**
 * Build the backup directory name for a run: `data.backup-v<fromVersion>-<timestamp>`. The timestamp
 * is PASSED IN (never generated here) so the name is deterministic in tests and so the caller owns
 * the single clock read for the whole migration run. Pure.
 *
 * @public
 */
export const backupDirName = (fromVersion: number, timestamp: string): string =>
  `${BACKUP_DIR_PREFIX}v${String(fromVersion)}-${sanitizeTimestamp(timestamp)}`;

/**
 * Take a full recursive copy of the `data/` tree into a TIMESTAMPED sibling
 * `data.backup-v<from>-<timestamp>/` BEFORE any rename runs. Each run gets a distinct name so a
 * crash-then-retry never overwrites the first run's backup (the user was burned by a past migration;
 * keeping every backup is the safety net). Any existing `data.backup-*` siblings are EXCLUDED from
 * the copy so backups never nest inside backups.
 *
 * The copy is VERIFIED to exist (a `stat` of the destination) before returning — a silent partial
 * copy must not let the apply step proceed believing the data is safe. Returns the absolute backup
 * path on success.
 *
 * @public
 */
export const backupDataDir = async (
  dataRoot: AbsolutePath,
  fromVersion: number,
  timestamp: string
): Promise<Result<string, StorageError>> => {
  const src = String(dataRoot);
  const dest = join(dirname(src), backupDirName(fromVersion, timestamp));

  try {
    await fs.cp(src, dest, {
      recursive: true,
      // Skip any nested backup dir (defensive — backups live as SIBLINGS of data/, not inside it,
      // but a misplaced one must never be recursively re-copied) and the destination itself.
      filter: (source) => {
        const name = basename(source);
        if (name.startsWith(BACKUP_DIR_PREFIX)) return false;
        return source !== dest;
      },
    });
  } catch (cause) {
    return Result.error(
      new StorageError({ subCode: 'io', message: `backup copy failed: ${src} → ${dest}`, path: dest, cause })
    );
  }

  // Verify the copy actually landed before we let any rename run on top of the originals.
  try {
    const stat = await fs.stat(dest);
    if (!stat.isDirectory()) {
      return Result.error(
        new StorageError({ subCode: 'io', message: `backup verify failed: ${dest} is not a directory`, path: dest })
      );
    }
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `backup verify failed: ${dest} not found after copy`,
        path: dest,
        cause,
      })
    );
  }

  return Result.ok(dest);
};

/** Replace filesystem-hostile characters (`:`) in an ISO timestamp so the dir name is portable. */
const sanitizeTimestamp = (timestamp: string): string => timestamp.replace(/:/g, '-');
