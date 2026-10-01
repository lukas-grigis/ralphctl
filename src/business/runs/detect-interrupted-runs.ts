import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import {
  liveSpawnsOf,
  sameIdentity,
  sameMachine,
  type LiveRunRecord,
  type LiveRunSpawn,
  type LiveRunStore,
  type ProcessLiveness,
} from '@src/business/runs/live-run.ts';

/** A run whose record outlived the harness process that owned it. */
export interface InterruptedRun {
  readonly record: LiveRunRecord;
  /** Spawns that were still running when the record was last written. */
  readonly liveSpawns: readonly LiveRunSpawn[];
}

export interface DetectInterruptedRunsDeps {
  readonly store: Pick<LiveRunStore, 'list'>;
  readonly liveness: ProcessLiveness;
}

/**
 * The owner is gone when its pid is dead, or alive but no longer the recorded process (a recycled
 * pid). Only meaningful for a record from this machine.
 */
export const ownerGone = async (record: LiveRunRecord, liveness: ProcessLiveness): Promise<boolean> => {
  const { owner } = record;
  if (!liveness.isAlive(owner.pid)) return true;
  if (owner.identity === undefined) return false;
  const current = await liveness.identify(owner.pid);
  // An unidentifiable live pid proves nothing — treat the run as still owned.
  return current !== undefined && !sameIdentity(current, owner.identity);
};

export interface DetectInterruptedRuns {
  execute(): Promise<Result<readonly InterruptedRun[], StorageError>>;
}

export const createDetectInterruptedRuns = (deps: DetectInterruptedRunsDeps): DetectInterruptedRuns => ({
  async execute() {
    const listed = await deps.store.list();
    if (!listed.ok) return Result.error(listed.error);
    const interrupted: InterruptedRun[] = [];
    const here = await deps.liveness.machine();
    for (const record of listed.value) {
      // Another machine's pids mean nothing here.
      if (!sameMachine(record.owner, here)) continue;
      if (await ownerGone(record, deps.liveness)) interrupted.push({ record, liveSpawns: liveSpawnsOf(record) });
    }
    return Result.ok(interrupted) as Result<readonly InterruptedRun[], StorageError>;
  },
});
