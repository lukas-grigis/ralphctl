/**
 * Holds a real advisory flow lock — the one an implement run holds for its whole run — until
 * `release()`, so a test can stand in for a live run in this or another process.
 */

import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';
import { sprintDir } from '@src/integration/persistence/storage.ts';

export interface HeldFlowLock {
  release(): Promise<void>;
}

const holdLock = async (
  locksRoot: AbsolutePath,
  worktreePath: AbsolutePath,
  purpose?: string
): Promise<HeldFlowLock> => {
  const lockPath = repoLockFile(locksRoot, worktreePath);
  if (!lockPath.ok) throw lockPath.error;
  let acquired!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const run = createFileLocker().withLock(
    lockPath.value,
    async () => {
      acquired();
      await gate;
    },
    purpose !== undefined ? { purpose } : {}
  );
  await Promise.race([ready, run.then((r) => (r.ok ? undefined : Promise.reject(r.error)))]);
  return {
    release: async () => {
      finish();
      const r = await run;
      if (!r.ok) throw r.error;
    },
  };
};

export const holdFlowLock = async (paths: StoragePaths): Promise<HeldFlowLock> =>
  holdLock(paths.locksRoot, paths.dataRoot);

/** The per-sprint lock an implement / review run holds on its sprint directory. */
export const holdSprintLock = async (
  paths: StoragePaths,
  sprint: Pick<Sprint, 'id' | 'slug'>,
  purpose = 'implement'
): Promise<HeldFlowLock> => {
  const dir = AbsolutePath.parse(sprintDir(paths.dataRoot, sprint.id, sprint.slug));
  if (!dir.ok) throw dir.error;
  return holdLock(paths.locksRoot, dir.value, purpose);
};
