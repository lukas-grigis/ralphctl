import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type {
  HousekeepingDisk,
  MemoryDirEntry,
  RunArtifactEntry,
} from '@src/business/housekeeping/housekeeping-disk.ts';
import { dirSizeBytes, listDir, pathIsDirectory, removeDir } from '@src/integration/io/fs.ts';
import { parseIdFromName, resolveSprintDir } from '@src/integration/persistence/storage.ts';
import { listRuns, removeRun } from '@src/integration/ai/runs/_engine/run-enumeration.ts';

export interface FsHousekeepingDiskDeps {
  readonly dataRoot: AbsolutePath;
  readonly memoryRoot: AbsolutePath;
  readonly runsRoot: AbsolutePath;
}

/** Child directories of the memory root; stray files are skipped. */
const listMemoryChildDirs = async (
  memoryRoot: AbsolutePath
): Promise<Result<ReadonlyArray<{ readonly name: string; readonly path: string }>, StorageError>> => {
  const entries = await listDir(String(memoryRoot));
  if (!entries.ok) return Result.error(entries.error);
  const dirs: Array<{ name: string; path: string }> = [];
  for (const name of entries.value) {
    const path = join(String(memoryRoot), name);
    const isDir = await pathIsDirectory(path);
    if (!isDir.ok) return Result.error(isDir.error);
    if (isDir.value) dirs.push({ name, path });
  }
  return Result.ok(dirs);
};

export const createFsHousekeepingDisk = (deps: FsHousekeepingDiskDeps): HousekeepingDisk => ({
  async sprintBytes(id) {
    const dir = await resolveSprintDir(deps.dataRoot, id);
    return dir === undefined ? 0 : dirSizeBytes(dir);
  },

  async listMemoryDirs() {
    const dirs = await listMemoryChildDirs(deps.memoryRoot);
    if (!dirs.ok) return Result.error(dirs.error);
    const out: MemoryDirEntry[] = [];
    for (const dir of dirs.value) {
      out.push({ name: dir.name, projectId: parseIdFromName(dir.name), bytes: await dirSizeBytes(dir.path) });
    }
    return Result.ok(out);
  },

  async listRunArtifacts() {
    const runs = await listRuns(deps.runsRoot);
    if (!runs.ok) {
      return Result.error(
        new StorageError({ subCode: 'io', message: runs.error.message, path: String(deps.runsRoot) })
      );
    }
    return Result.ok(
      runs.value.map((run): RunArtifactEntry => ({
        flow: run.flow,
        runId: run.runId,
        startedAt: run.timestamp === null ? null : IsoTimestamp.fromDate(run.timestamp),
        bytes: run.sizeBytes,
      }))
    );
  },

  async removeMemoryDirs(projectId) {
    if (projectId.length === 0) return Result.ok(0);
    const dirs = await listMemoryChildDirs(deps.memoryRoot);
    if (!dirs.ok) return Result.error(dirs.error);
    let count = 0;
    for (const dir of dirs.value) {
      if (parseIdFromName(dir.name) !== projectId) continue;
      const removed = await removeDir(dir.path);
      if (!removed.ok && !(removed.error instanceof NotFoundError)) return Result.error(removed.error);
      if (removed.ok) count += 1;
    }
    return Result.ok(count);
  },

  removeRunArtifact: (run) => removeRun(deps.runsRoot, run),
});
