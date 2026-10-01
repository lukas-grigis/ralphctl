import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintLockReader } from '@src/business/runs/find-live-sprint-owner.ts';
import { readLockOwner } from '@src/integration/io/file-locker.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';
import { sprintDir } from '@src/integration/persistence/storage.ts';

export interface SprintLockReaderDeps {
  readonly dataRoot: AbsolutePath;
  readonly locksRoot: AbsolutePath;
}

/** Same key implement and review lock on: the sprint directory. */
export const createSprintLockReader = (deps: SprintLockReaderDeps): SprintLockReader => ({
  async holderOf(sprint) {
    const dir = AbsolutePath.parse(sprintDir(deps.dataRoot, sprint.id, sprint.slug));
    if (!dir.ok) return undefined;
    const lock = repoLockFile(deps.locksRoot, dir.value);
    if (!lock.ok) return undefined;
    const owner = await readLockOwner(String(lock.value));
    if (owner === undefined) return undefined;
    return {
      pid: owner.pid,
      host: owner.host,
      ...(owner.machineId !== undefined ? { machineId: owner.machineId } : {}),
    };
  },
});
