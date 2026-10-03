import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';

export interface WriteWithBackupDeps {
  readonly writeFile: WriteFile;
  readonly clock: () => IsoTimestamp;
  readonly logger: Logger;
}

/** Overwrite `targetPath`, first copying any existing file to `<targetPath>.bak.<ISO, colons → hyphens>`. */
export const writeWithBackup = async (
  deps: WriteWithBackupDeps,
  targetPath: AbsolutePath,
  content: string,
  label: string
): Promise<Result<void, DomainError>> => {
  const path = String(targetPath);
  let existing: string | undefined;
  try {
    existing = await fs.readFile(path, 'utf8');
  } catch (cause) {
    // Absent → nothing to back up; any other read failure refuses the write rather than overwrite without a backup.
    if (!isNodeErrnoCode(cause, 'ENOENT')) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `${label}: cannot read existing ${path} for backup — refusing to overwrite`,
          path,
          cause,
        })
      );
    }
  }

  if (existing !== undefined) {
    const backupPath = AbsolutePath.parse(`${path}.bak.${String(deps.clock()).replace(/:/g, '-')}`);
    if (!backupPath.ok) return Result.error(backupPath.error);
    const backup = await deps.writeFile(backupPath.value, existing);
    if (!backup.ok) return Result.error(backup.error);
    deps.logger.info(`backup written at ${String(backupPath.value)}`, { backupPath: String(backupPath.value) });
  }

  const written = await deps.writeFile(targetPath, content);
  return written.ok ? Result.ok(undefined) : Result.error(written.error);
};
