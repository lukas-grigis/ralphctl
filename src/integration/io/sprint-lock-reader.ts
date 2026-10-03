import { promises as fs } from 'node:fs';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ProcessIdentity } from '@src/business/runs/live-run.ts';
import type { SprintLockReader } from '@src/business/runs/find-live-sprint-owner.ts';
import { DEFAULT_STALE_AFTER_MS, readLockOwner } from '@src/integration/io/file-locker.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';
import { sprintDir } from '@src/integration/persistence/storage.ts';

export interface SprintLockReaderDeps {
  readonly dataRoot: AbsolutePath;
  readonly locksRoot: AbsolutePath;
}

const identityOf = (value: unknown): ProcessIdentity | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { startedAt, command } = value as { startedAt?: unknown; command?: unknown };
  return typeof startedAt === 'string' && typeof command === 'string' ? { startedAt, command } : undefined;
};

/** Whether the lock dir's heartbeat is within the locker's stale window; a crashed holder stops refreshing it. */
const heartbeatFresh = async (lockDir: string, now: number): Promise<boolean> => {
  try {
    const stat = await fs.lstat(lockDir);
    return stat.isDirectory() && now - stat.mtimeMs <= DEFAULT_STALE_AFTER_MS;
  } catch {
    return false;
  }
};

/** Same key implement and review lock on: the sprint directory. */
export const createSprintLockReader = (deps: SprintLockReaderDeps): SprintLockReader => ({
  async holderOf(sprint) {
    const dir = AbsolutePath.parse(sprintDir(deps.dataRoot, sprint.id, sprint.slug));
    if (!dir.ok) return undefined;
    const lock = repoLockFile(deps.locksRoot, dir.value);
    if (!lock.ok) return undefined;
    if (!(await heartbeatFresh(String(lock.value), Date.now()))) return undefined;
    const owner = await readLockOwner(String(lock.value));
    if (owner === undefined) return undefined;
    const identity = identityOf(owner.identity);
    return {
      pid: owner.pid,
      host: owner.host,
      ...(owner.machineId !== undefined ? { machineId: owner.machineId } : {}),
      ...(identity !== undefined ? { identity } : {}),
    };
  },
});
