/**
 * Holds a real advisory flow lock — the one an implement run holds for its whole run — until
 * `release()`, so a test can stand in for a live run in this or another process.
 */

import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { createFileLocker } from '@src/integration/io/file-locker.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';

export interface HeldFlowLock {
  release(): Promise<void>;
}

export const holdFlowLock = async (paths: StoragePaths): Promise<HeldFlowLock> => {
  const lockPath = repoLockFile(paths.locksRoot, paths.dataRoot);
  if (!lockPath.ok) throw lockPath.error;
  let acquired!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const run = createFileLocker().withLock(lockPath.value, async () => {
    acquired();
    await gate;
  });
  await Promise.race([ready, run.then((r) => (r.ok ? undefined : Promise.reject(r.error)))]);
  return {
    release: async () => {
      finish();
      const r = await run;
      if (!r.ok) throw r.error;
    },
  };
};
