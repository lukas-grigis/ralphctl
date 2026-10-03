import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Slug } from '@src/domain/value/slug.ts';
import {
  sameMachine,
  type LiveRunStore,
  type MachineRef,
  type ProcessIdentity,
  type ProcessLiveness,
} from '@src/business/runs/live-run.ts';
import { ownerGone, processGone } from '@src/business/runs/detect-interrupted-runs.ts';

export interface LockHolder extends MachineRef {
  readonly pid: number;
  /** `ps` identity the holder stamped; compared so a recycled pid does not read as the holder. */
  readonly identity?: ProcessIdentity;
}

/** Resolves the holder of a sprint's flow lock, or `undefined` when there is none or its heartbeat has gone stale. */
export interface SprintLockReader {
  holderOf(sprint: { readonly id: SprintId; readonly slug: Slug }): Promise<LockHolder | undefined>;
}

export interface FindLiveSprintOwnerDeps {
  readonly store: Pick<LiveRunStore, 'list'>;
  readonly liveness: ProcessLiveness;
  readonly locks: SprintLockReader;
}

export interface LiveSprintOwner {
  readonly pid: number;
  readonly via: 'run-record' | 'lock';
}

/** A `running` attempt on a sprint another live process works is in flight, not interrupted. */
export interface FindLiveSprintOwner {
  execute(sprint: {
    readonly id: SprintId;
    readonly slug: Slug;
  }): Promise<Result<LiveSprintOwner | undefined, StorageError>>;
}

export const createFindLiveSprintOwner = (deps: FindLiveSprintOwnerDeps): FindLiveSprintOwner => ({
  async execute(sprint) {
    const listed = await deps.store.list();
    if (!listed.ok) return Result.error(listed.error);
    const here = await deps.liveness.machine();
    const foreignHere = (owner: MachineRef & { readonly pid: number }): boolean =>
      owner.pid !== deps.liveness.selfPid && sameMachine(owner, here);

    for (const record of listed.value) {
      if (record.sprintId !== String(sprint.id) || !foreignHere(record.owner)) continue;
      if (!(await ownerGone(record, deps.liveness))) {
        return Result.ok({ pid: record.owner.pid, via: 'run-record' }) as Result<LiveSprintOwner, StorageError>;
      }
    }
    const holder = await deps.locks.holderOf(sprint);
    if (holder !== undefined && foreignHere(holder) && !(await processGone(holder, deps.liveness))) {
      return Result.ok({ pid: holder.pid, via: 'lock' }) as Result<LiveSprintOwner, StorageError>;
    }
    return Result.ok(undefined) as Result<LiveSprintOwner | undefined, StorageError>;
  },
});
