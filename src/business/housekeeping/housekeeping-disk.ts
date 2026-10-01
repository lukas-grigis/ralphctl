import type { Result } from '@src/domain/result.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** One directory under the memory root; `projectId` is the id parsed from its name, unvalidated. */
export interface MemoryDirEntry {
  readonly name: string;
  readonly projectId: string;
  readonly bytes: number;
}

/** One per-run forensic artifact dir; `startedAt` is null when its name carries no timestamp. */
export interface RunArtifactEntry {
  readonly flow: string;
  readonly runId: string;
  readonly startedAt: IsoTimestamp | null;
  readonly bytes: number;
}

/** Disk-level reads and deletes the housekeeping use cases need beyond the aggregate repositories. */
export interface HousekeepingDisk {
  /** Bytes under the sprint's directory; 0 when it doesn't exist. */
  sprintBytes(id: SprintId): Promise<number>;
  listMemoryDirs(): Promise<Result<readonly MemoryDirEntry[], StorageError>>;
  listRunArtifacts(): Promise<Result<readonly RunArtifactEntry[], StorageError>>;
  /** Removes every memory dir for the id (slugged and legacy bare forms); resolves to the count removed. */
  removeMemoryDirs(projectId: string): Promise<Result<number, StorageError>>;
  removeRunArtifact(run: {
    readonly flow: string;
    readonly runId: string;
  }): Promise<Result<void, NotFoundError | StorageError>>;
}
